import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import { enqueueJob } from "../../jobs/queue.js";
import { approvalService } from "../../services/approval.service.js";
import { organizationService } from "../../services/organization.service.js";
import { conversationService } from "../../services/conversation.service.js";
import { whatsappService } from "../../services/whatsapp.service.js";
import { withOrganization } from "../../context/tenant.js";
import { BOT_HELP_GUIDE } from "../../prompts/system.js";
import {
  isRestartCommand,
  looksLikeNewPurchaseOrder,
  looksLikeReconcileRequest,
  normalizeChatReply,
} from "../../utils/matching.js";
import { ApprovalGateType } from "@prisma/client";
import type { WhatsAppInboundMessage } from "../../types/index.js";

interface RawWhatsAppMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string };
  document?: { id: string; mime_type: string; filename?: string };
  group_id?: string;
  context?: { group_id?: string; from?: string; id?: string };
}

interface WhatsAppWebhookPayload {
  object: string;
  entry?: Array<{
    /** WhatsApp Business Account ID the event belongs to (tenant identifier) */
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        messages?: RawWhatsAppMessage[];
        metadata?: {
          phone_number_id?: string;
          display_phone_number?: string;
          organization_id?: string;
        };
        contacts?: Array<{ wa_id: string }>;
      };
    }>;
  }>;
}

export type WhatsAppWebhookResult = { status: string; messageId?: string };

function parseInboundMessage(
  raw: RawWhatsAppMessage,
  whatsappPhoneNumberId?: string,
  whatsappBusinessAccountId?: string
): WhatsAppInboundMessage {
  const text = raw.text?.body;
  const mentionsBot = text?.toLowerCase().includes("@bot") ?? false;
  const groupId = raw.group_id ?? raw.context?.group_id;
  const looksLikeGroup =
    Boolean(groupId) ||
    raw.from.includes("@g.us") ||
    raw.from.toLowerCase().startsWith("group:");

  return {
    messageId: raw.id,
    from: raw.from.startsWith("+") || looksLikeGroup ? raw.from.replace(/^group:/i, "") : `+${raw.from}`,
    timestamp: raw.timestamp,
    type: raw.type as WhatsAppInboundMessage["type"],
    text,
    mediaId: raw.image?.id ?? raw.document?.id,
    mimeType: raw.image?.mime_type ?? raw.document?.mime_type,
    filename: raw.document?.filename,
    isGroup: looksLikeGroup,
    groupId: groupId ?? (raw.from.includes("@g.us") ? raw.from : undefined),
    mentionsBot,
    whatsappPhoneNumberId,
    whatsappBusinessAccountId,
  };
}

export function buildTestWebhookPayload(input: {
  message: string;
  from: string;
  phoneNumberId?: string;
  businessAccountId?: string;
  messageId?: string;
  isGroup?: boolean;
  groupId?: string;
  type?: "text" | "image" | "document";
  filename?: string;
  organizationId?: string;
}): WhatsAppWebhookPayload {
  const fromDigits = input.from.replace(/^\+/, "");
  const messageId = input.messageId ?? `wamid.admin-test-${Date.now()}`;
  const type = input.type ?? "text";
  const message: RawWhatsAppMessage = {
    id: messageId,
    from: fromDigits,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type,
    ...(type === "text" ? { text: { body: input.message } } : {}),
    ...(type === "image" ? { image: { id: "mock-media", mime_type: "image/jpeg" } } : {}),
    ...(type === "document"
      ? {
          document: {
            id: "mock-media",
            mime_type: "application/pdf",
            filename: input.filename ?? "invoice.pdf",
          },
        }
      : {}),
    ...(input.isGroup || input.groupId
      ? { group_id: input.groupId ?? "test-group" }
      : {}),
  };

  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: input.businessAccountId,
        changes: [
          {
            value: {
              metadata: {
                ...(input.phoneNumberId ? { phone_number_id: input.phoneNumberId } : {}),
                ...(input.organizationId ? { organization_id: input.organizationId } : {}),
              },
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

export async function processWhatsAppWebhook(
  payload: WhatsAppWebhookPayload
): Promise<WhatsAppWebhookResult> {
  if (payload.object !== "whatsapp_business_account") {
    return { status: "ignored" };
  }

  let lastMessageId: string | undefined;

  for (const entry of payload.entry ?? []) {
    const businessAccountId = entry.id;

    for (const change of entry.changes ?? []) {
      const phoneNumberId = change.value?.metadata?.phone_number_id;
      const organizationIdHint = change.value?.metadata?.organization_id;

      for (const message of change.value?.messages ?? []) {
        const inbound = parseInboundMessage(message, phoneNumberId, businessAccountId);
        if (organizationIdHint) inbound.organizationId = organizationIdHint;
        lastMessageId = inbound.messageId;

        const organization = await organizationService.resolveFromWhatsApp(inbound);

        if (!organization) {
          logger.warn(
            { phoneNumberId, businessAccountId, from: inbound.from },
            "Inbound WhatsApp message could not be resolved to a tenant — dropping"
          );
          continue;
        }

        await conversationService.recordInbound(organization.id, inbound);

        const result = await withOrganization(
          organization.id,
          async () => {
            if (inbound.text) {
              const response = normalizeChatReply(inbound.text);
              const pendingApproval = await approvalService.findPendingForOrganization(
                organization.id
              );

              if (pendingApproval && !inbound.isGroup) {
                if (isRestartCommand(response)) {
                  await approvalService.abandonPending(pendingApproval, "supervisor restarted");
                  await whatsappService.sendText(
                    inbound.from,
                    "Cancelled the previous request. Send a new order, invoice, or reconcile message.\n\n" +
                      BOT_HELP_GUIDE
                  );
                  return { status: "restarted" as const, messageId: inbound.messageId };
                }

                const waitingForItemDetails =
                  pendingApproval.gateType === ApprovalGateType.NEW_PO_PRICE;
                if (
                  !waitingForItemDetails &&
                  (looksLikeNewPurchaseOrder(response) || looksLikeReconcileRequest(response))
                ) {
                  await approvalService.abandonPending(pendingApproval, "supervisor changed topic");
                  await whatsappService.sendText(
                    inbound.from,
                    "That doesn't match the question I asked, so I cancelled the previous step and will start from this message. Reply *restart* any time to do this on purpose."
                  );
                  await enqueueJob("whatsapp.message", {
                    ...inbound,
                    organizationId: organization.id,
                  });
                  return { status: "restarted_new_intent" as const, messageId: inbound.messageId };
                }

                await approvalService.resolve(pendingApproval.id, response, inbound.from);
                await enqueueJob("approval.resolved", {
                  approvalId: pendingApproval.id,
                  response,
                  organizationId: organization.id,
                });
                return { status: "approval_processed" as const, messageId: inbound.messageId };
              }

              if (pendingApproval) {
                await approvalService.resolve(pendingApproval.id, response, inbound.from);
                await enqueueJob("approval.resolved", {
                  approvalId: pendingApproval.id,
                  response,
                  organizationId: organization.id,
                });
                return { status: "approval_processed" as const, messageId: inbound.messageId };
              }
            }

            await enqueueJob("whatsapp.message", {
              ...inbound,
              organizationId: organization.id,
            });
            return { status: "ok" as const, messageId: inbound.messageId };
          },
          organization.slug
        );

        if (result.status !== "ok") {
          return result;
        }
      }
    }
  }

  return { status: "ok", messageId: lastMessageId };
}

/**
 * Verify Meta's X-Hub-Signature-256 header against the raw request body.
 * Skipped when META_APP_SECRET is not configured (local development).
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined
): boolean {
  if (!config.META_APP_SECRET) return true;
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const expected = crypto
    .createHmac("sha256", config.META_APP_SECRET)
    .update(rawBody)
    .digest("hex");
  const received = signatureHeader.slice("sha256=".length);

  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"));
}

export async function registerWhatsAppRoutes(app: FastifyInstance): Promise<void> {
  app.get("/webhooks/whatsapp", async (request, reply) => {
    const query = request.query as {
      "hub.mode"?: string;
      "hub.verify_token"?: string;
      "hub.challenge"?: string;
    };

    if (
      query["hub.mode"] === "subscribe" &&
      query["hub.verify_token"] === config.WHATSAPP_VERIFY_TOKEN
    ) {
      return reply.send(query["hub.challenge"]);
    }

    return reply.code(403).send("Forbidden");
  });

  // Scoped plugin: keep the raw body for signature verification on this route only
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body)
    );

    scope.post("/webhooks/whatsapp", async (request, reply) => {
      const rawBody = request.body as Buffer;
      const signature = request.headers["x-hub-signature-256"] as string | undefined;
      console.log(rawBody);
      if (!verifyWebhookSignature(rawBody, signature)) {
        logger.warn("WhatsApp webhook rejected: invalid X-Hub-Signature-256");
        return reply.code(401).send({ error: "Invalid signature" });
      }

      let payload: WhatsAppWebhookPayload;
      try {
        payload = JSON.parse(rawBody.toString("utf8")) as WhatsAppWebhookPayload;
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }

      const result = await processWhatsAppWebhook(payload);
      return reply.send(result);
    });
  });
}


//+6564164813