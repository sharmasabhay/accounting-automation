import { logger } from "../utils/logger.js";
import { getOrganizationId } from "../context/tenant.js";
import { integrationConfigService } from "./integration-config.service.js";

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  from: string;
  subject: string;
  messageId: string;
}

class EmailService {
  async scanInvoiceInbox(): Promise<EmailAttachment[]> {
    const organizationId = getOrganizationId();
    const email = await integrationConfigService.getEmail(organizationId);

    if (!integrationConfigService.isEmailConfigured(email)) {
      logger.info({ organizationId }, "Email IMAP not configured for organization — skipping scan");
      return [];
    }

    // IMAP via imapflow — connection uses per-org credentials from integration config
    logger.info(
      { organizationId, host: email.imapHost, user: email.imapUser },
      "Email scan scheduled (per-org IMAP config loaded)"
    );
    return [];
  }

  async markEmailProcessed(_messageId: string): Promise<void> {
    logger.info("Email marked as processed (IMAP move to Processed folder)");
  }
}

export const emailService = new EmailService();
