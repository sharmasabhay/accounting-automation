import fs from "node:fs/promises";
import { ImapFlow } from "imapflow";
import { logger } from "../utils/logger.js";
import { getOrganizationId } from "../context/tenant.js";
import { integrationConfigService } from "./integration-config.service.js";
import { authorizationService } from "./authorization.service.js";
import { isSoaDocument } from "../utils/matching.js";
import type { SavedEmailAttachment } from "../types/index.js";

/** Unread messages processed per IMAP scan. Remainder stay unread for the next run. */
export const IMAP_UNREAD_BATCH = 25;

const PUBLIC_MAILBOX_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "aol.com",
]);

const IMAP_TIMEOUTS = {
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 20_000,
};

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  from: string;
  subject: string;
  messageId: string;
  kind: "invoice" | "soa";
  savedPath?: string;
  uid?: number;
}

function senderMatchesSupplierDomain(from: string, domains: string[]): boolean {
  const domain = from.split("@")[1]?.trim().toLowerCase();
  return Boolean(domain && domains.includes(domain));
}

function unreadFromSupplierSearch(
  domains: string[],
  options?: { soaOnly?: boolean }
): Record<string, unknown> {
  const fromDomains = domains.filter((domain) => !PUBLIC_MAILBOX_DOMAINS.has(domain));
  const fromClauses = fromDomains.map((domain) => ({ from: `@${domain}` }));
  const soaClauses = [
    { subject: "SOA" },
    { subject: "statement of account" },
    { subject: "Statement" },
  ];
  if (options?.soaOnly) {
    if (fromClauses.length === 1) {
      return { seen: false, ...fromClauses[0], or: soaClauses };
    }
    if (fromClauses.length > 1) {
      return { seen: false, or: [...fromClauses, ...soaClauses] };
    }
    return { seen: false, or: soaClauses };
  }
  if (fromClauses.length === 1) {
    return { seen: false, ...fromClauses[0] };
  }
  if (fromClauses.length > 1) {
    return { seen: false, or: fromClauses };
  }
  return { seen: false, or: soaClauses };
}

function describeImapError(error: unknown, user: string, host: string): Error {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const response = String(record.response ?? record.responseText ?? "");
  const authFailed =
    record.authenticationFailed === true ||
    String(record.serverResponseCode ?? "").toUpperCase().includes("AUTHENTICATION") ||
    /invalid credentials|authenticationfailed/i.test(response);
  if (authFailed) {
    const gmail = /gmail/i.test(host) || /gmail\.com$/i.test(user);
    return new Error(
      gmail
        ? `Gmail IMAP rejected login for ${user}. Use a 16-character App Password (Google Account → Security → 2-Step Verification → App passwords), not the normal Gmail password. Save it in Admin → Integrations → EMAIL.`
        : `IMAP login failed for ${user} on ${host}. Check the username and password in Admin → Integrations → EMAIL.`
    );
  }
  const detail = response || (error instanceof Error ? error.message : String(error));
  return new Error(`IMAP scan failed (${host}): ${detail}`);
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

  async scanInvoiceInbox(options?: { throwOnError?: boolean; soaOnly?: boolean }): Promise<EmailAttachment[]> {
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

    const supplierDomains = await authorizationService.listSupplierEmailDomains(organizationId);
    if (supplierDomains.length === 0) {
      logger.info({ organizationId }, "IMAP scan skipped — no supplier email domains configured");
      return [];
    }

    const attachments: EmailAttachment[] = [];
    const imapUser = email.imapUser!.trim();
    const imapHost = email.imapHost!.trim();
    // Gmail app passwords are often copied with spaces (xxxx xxxx xxxx xxxx).
    const imapPassword = email.imapPassword!.replace(/\s+/g, "");
    const client = new ImapFlow({
      host: imapHost,
      port: email.imapPort ?? 993,
      secure: true,
      auth: { user: imapUser, pass: imapPassword },
      logger: false,
      ...IMAP_TIMEOUTS,
    });

    try {
      await client.connect();
      const mailbox = email.inboxFolder ?? "INBOX";
      await client.mailboxOpen(mailbox);

      const unread = await client.search(
        unreadFromSupplierSearch(supplierDomains, { soaOnly: options?.soaOnly }),
        { uid: true }
      );
      const unreadUids = Array.isArray(unread) ? unread : [];
      const batchUids = unreadUids.slice(0, IMAP_UNREAD_BATCH);
      if (unreadUids.length > batchUids.length) {
        logger.info(
          {
            organizationId,
            domains: supplierDomains,
            matchingUnread: unreadUids.length,
            processing: batchUids.length,
            remaining: unreadUids.length - batchUids.length,
          },
          "IMAP unread cap — remaining supplier messages stay unread for the next scan"
        );
      }
      if (batchUids.length === 0) {
        logger.info({ organizationId, domains: supplierDomains }, "No unread supplier emails");
        return [];
      }

      for await (const message of client.fetch(
        batchUids,
        { envelope: true, bodyStructure: true, uid: true },
        { uid: true }
      )) {
        const from = message.envelope?.from?.[0]?.address ?? "unknown@unknown";
        if (!senderMatchesSupplierDomain(from, supplierDomains)) {
          logger.info({ from, uid: message.uid }, "Skipping IMAP message — sender is not a supplier domain");
          continue;
        }
        const subject = message.envelope?.subject ?? "";
        const messageId = message.envelope?.messageId ?? String(message.uid);
        const parts = this.collectParts(message.bodyStructure);
        logger.info(
          { from, subject, uid: message.uid, parts: parts.map((part) => part.filename ?? part.type) },
          "Unread supplier inbox message"
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
            uid: message.uid,
          });
        }
      }
    } catch (error) {
      const wrapped = describeImapError(error, imapUser, imapHost);
      logger.error({ err: error, organizationId }, wrapped.message);
      if (options?.throwOnError) throw wrapped;
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

  async markEmailProcessed(messageId: string, uid?: number): Promise<void> {
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
      auth: {
        user: email.imapUser!.trim(),
        pass: email.imapPassword!.replace(/\s+/g, ""),
      },
      logger: false,
      ...IMAP_TIMEOUTS,
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
      const found =
        uid ??
        (await client.search({ header: ["Message-ID", messageId] }, { uid: true }))?.[0];
      if (found == null) return;
      await client.messageMove(String(found), processed, { uid: true });
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
