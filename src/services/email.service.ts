import fs from "node:fs/promises";
import { ImapFlow } from "imapflow";
import { logger } from "../utils/logger.js";
import { getOrganizationId } from "../context/tenant.js";
import { integrationConfigService } from "./integration-config.service.js";
import { isSoaDocument } from "../utils/matching.js";
import type { SavedEmailAttachment } from "../types/index.js";

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  from: string;
  subject: string;
  messageId: string;
  kind: "invoice" | "soa";
  savedPath?: string;
}

class EmailService {
  private fixtures: EmailAttachment[] = [];

  injectFixtures(attachments: EmailAttachment[]): void {
    this.fixtures = attachments;
  }

  async loadSavedAttachments(attachments: SavedEmailAttachment[]): Promise<EmailAttachment[]> {
    return Promise.all(
      attachments.map(async (attachment) => ({
        filename: attachment.filename,
        content: await fs.readFile(attachment.filePath),
        contentType: attachment.contentType,
        from: attachment.from,
        subject: attachment.subject,
        messageId: attachment.messageId,
        kind: attachment.kind,
        savedPath: attachment.filePath,
      }))
    );
  }

  async scanInvoiceInbox(options?: { throwOnError?: boolean }): Promise<EmailAttachment[]> {
    if (this.fixtures.length > 0) {
      const injected = this.fixtures;
      this.fixtures = [];
      logger.info({ count: injected.length }, "[DRY_RUN] Using injected email fixtures");
      return injected;
    }

    const organizationId = getOrganizationId();
    const email = await integrationConfigService.getEmail(organizationId);

    if (!integrationConfigService.isEmailConfigured(email)) {
      logger.info({ organizationId }, "Email IMAP not configured for organization — skipping scan");
      return [];
    }

    const attachments: EmailAttachment[] = [];
    const client = new ImapFlow({
      host: email.imapHost!,
      port: email.imapPort ?? 993,
      secure: true,
      auth: { user: email.imapUser!, pass: email.imapPassword! },
      logger: false,
    });

    try {
      await client.connect();
      const mailbox = email.inboxFolder ?? "INBOX";
      await client.mailboxOpen(mailbox);

      for await (const message of client.fetch({ seen: false }, { envelope: true, bodyStructure: true, uid: true })) {
        const from = message.envelope?.from?.[0]?.address ?? "unknown@unknown";
        const subject = message.envelope?.subject ?? "";
        const messageId = message.envelope?.messageId ?? String(message.uid);
        const parts = this.collectParts(message.bodyStructure);
        logger.info(
          { from, subject, uid: message.uid, parts: parts.map((part) => part.filename ?? part.type) },
          "Unread inbox message"
        );
        for (const part of parts) {
          const downloaded = await client.download(String(message.uid), part.part, { uid: true });
          const chunks: Buffer[] = [];
          for await (const chunk of downloaded.content) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const content = Buffer.concat(chunks);
          const filename = part.filename ?? `attachment-${message.uid}`;
          attachments.push({
            filename,
            content,
            contentType: part.type,
            from,
            subject,
            messageId,
            kind: isSoaDocument(filename, subject) ? "soa" : "invoice",
          });
        }
      }
    } catch (error) {
      logger.error({ err: error, organizationId }, "IMAP scan failed");
      if (options?.throwOnError) throw error;
      return [];
    } finally {
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }

    return attachments;
  }

  async markEmailProcessed(messageId: string): Promise<void> {
    const organizationId = getOrganizationId();
    const email = await integrationConfigService.getEmail(organizationId);
    if (!integrationConfigService.isEmailConfigured(email)) {
      logger.info({ messageId }, "Email marked as processed (no IMAP)");
      return;
    }

    const client = new ImapFlow({
      host: email.imapHost!,
      port: email.imapPort ?? 993,
      secure: true,
      auth: { user: email.imapUser!, pass: email.imapPassword! },
      logger: false,
    });

    try {
      await client.connect();
      await client.mailboxOpen(email.inboxFolder ?? "INBOX");
      const processed = email.processedFolder ?? "Processed";
      try {
        await client.mailboxCreate(processed);
      } catch {
        /* already exists */
      }
      for await (const message of client.fetch({ seen: false }, { envelope: true, uid: true })) {
        if (message.envelope?.messageId !== messageId) continue;
        await client.messageMove(String(message.uid), processed, { uid: true });
      }
    } catch (error) {
      logger.warn({ err: error, messageId }, "Could not move processed email");
    } finally {
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }
  }

  private collectParts(
    node: unknown,
    fallbackPart = "1"
  ): Array<{ part: string; filename?: string; type: string }> {
    if (!node || typeof node !== "object") return [];
    const body = node as {
      type?: string;
      subtype?: string;
      part?: string;
      disposition?: string;
      dispositionParameters?: { filename?: string };
      parameters?: { name?: string };
      childNodes?: unknown[];
    };
    const results: Array<{ part: string; filename?: string; type: string }> = [];
    const filename = body.dispositionParameters?.filename ?? body.parameters?.name;
    const rawType = (body.type ?? "").toLowerCase();
    const mime = rawType.includes("/")
      ? rawType
      : `${rawType || "application"}/${(body.subtype ?? "octet-stream").toLowerCase()}`;
    const isFile =
      Boolean(filename) ||
      mime.startsWith("image/") ||
      mime === "application/pdf" ||
      /attachment/i.test(body.disposition ?? "");
    if (isFile && !mime.startsWith("multipart/") && !mime.startsWith("text/")) {
      results.push({ part: body.part ?? fallbackPart, filename, type: mime });
    }
    for (const [index, child] of (body.childNodes ?? []).entries()) {
      const childPart =
        (child as { part?: string })?.part ??
        (body.part ? `${body.part}.${index + 1}` : String(index + 1));
      results.push(...this.collectParts(child, childPart));
    }
    return results;
  }
}

export const emailService = new EmailService();
