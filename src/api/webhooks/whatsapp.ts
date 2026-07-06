import type { FastifyInstance } from "fastify";
import { config } from "../../config/index.js";
import { enqueueJob } from "../../jobs/queue.js";
import { approvalService } from "../../services/approval.service.js";
import { organizationService } from "../../services/organization.service.js";
import type { WhatsAppInboundMessage } from "../../types/index.js";

interface RawWhatsAppMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string };
  document?: { id: string; mime_type: string; filename?: string };
}

interface WhatsAppWebhookPayload {
  object: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: RawWhatsAppMessage[];
        metadata?: { phone_number_id?: string };
        contacts?: Array<{ wa_id: string }>;
      };
    }>;
  }>;
}

export type WhatsAppWebhookResult = { status: string; messageId?: string };

function parseInboundMessage(
  raw: RawWhatsAppMessage,
  whatsappPhoneNumberId?: string
): WhatsAppInboundMessage {
  const text = raw.text?.body;
  const mentionsBot = text?.toLowerCase().includes("@bot") ?? false;

  return {
    messageId: raw.id,
    from: raw.from.startsWith("+") ? raw.from : `+${raw.from}`,
    timestamp: raw.timestamp,
    type: raw.type as WhatsAppInboundMessage["type"],
    text,
    mediaId: raw.image?.id ?? raw.document?.id,
    mimeType: raw.image?.mime_type ?? raw.document?.mime_type,
    filename: raw.document?.filename,
    isGroup: false,
    mentionsBot,
    whatsappPhoneNumberId,
  };
}

export function buildTestWebhookPayload(input: {
  message: string;
  from: string;
  phoneNumberId?: string;
  messageId?: string;
}): WhatsAppWebhookPayload {
  const fromDigits = input.from.replace(/^\+/, "");
  const messageId = input.messageId ?? `wamid.admin-test-${Date.now()}`;

  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: input.phoneNumberId
                ? { phone_number_id: input.phoneNumberId }
                : undefined,
              messages: [
                {
                  id: messageId,
                  from: fromDigits,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: input.message },
                },
              ],
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
    for (const change of entry.changes ?? []) {
      const phoneNumberId = change.value?.metadata?.phone_number_id;

      for (const message of change.value?.messages ?? []) {
        const inbound = parseInboundMessage(message, phoneNumberId);
        lastMessageId = inbound.messageId;

        const organization = await organizationService.resolveFromWhatsApp(inbound);

        if (organization && inbound.text) {
          const response = inbound.text.trim();
          if (["yes", "no", "ready", "approve"].includes(response.toLowerCase())) {
            const pendingApproval = await approvalService.findPendingForOrganization(
              organization.id
            );

            if (pendingApproval) {
              await approvalService.resolve(pendingApproval.id, response, inbound.from);
              await enqueueJob("approval.resolved", {
                approvalId: pendingApproval.id,
                response,
                organizationId: organization.id,
              });
              return { status: "approval_processed", messageId: inbound.messageId };
            }
          }
        }

        await enqueueJob("whatsapp.message", { ...inbound });
      }
    }
  }

  return { status: "ok", messageId: lastMessageId };
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

  app.post("/webhooks/whatsapp", async (request, reply) => {
    const payload = request.body as WhatsAppWebhookPayload;
    const result = await processWhatsAppWebhook(payload);
    return reply.send(result);
  });
}
