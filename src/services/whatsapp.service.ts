import { logger } from "../utils/logger.js";
import { logBotMessage } from "../utils/workflow-log.js";
import { getOrganizationId } from "../context/tenant.js";
import { integrationConfigService } from "./integration-config.service.js";
import { conversationService } from "./conversation.service.js";

class WhatsAppService {
  async sendText(
    to: string,
    text: string,
    options?: { isGroup?: boolean }
  ): Promise<{ messageId: string }> {
    const organizationId = getOrganizationId();
    const wa = await integrationConfigService.getWhatsApp(organizationId);

    if (!integrationConfigService.isWhatsAppConfigured(wa)) {
      logBotMessage(to, text, true);
      await conversationService.recordOutbound(to, text, Boolean(options?.isGroup));
      return { messageId: `dry-${Date.now()}` };
    }

    const url = `https://graph.facebook.com/v21.0/${wa.phoneNumberId}/messages`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${wa.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to.replace(/\D/g, ""),
        type: "text",
        text: { body: text },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`WhatsApp API error: ${response.status} ${body}`);
    }

    const data = (await response.json()) as { messages: Array<{ id: string }> };
    logBotMessage(to, text, false);
    await conversationService.recordOutbound(to, text, Boolean(options?.isGroup));
    return { messageId: data.messages[0]?.id ?? "unknown" };
  }

  async sendGroupText(groupId: string, text: string): Promise<{ messageId: string }> {
    logger.info({ groupId, text }, "Sending group message");
    return this.sendText(groupId, text, { isGroup: true });
  }

  async downloadMedia(mediaId: string): Promise<Buffer> {
    const organizationId = getOrganizationId();
    const wa = await integrationConfigService.getWhatsApp(organizationId);

    if (!integrationConfigService.isWhatsAppConfigured(wa)) {
      return Buffer.from("mock-media");
    }

    const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${wa.apiToken}` },
    });
    if (!metaRes.ok) throw new Error("Failed to get media URL");

    const meta = (await metaRes.json()) as { url: string };
    const fileRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${wa.apiToken}` },
    });
    if (!fileRes.ok) throw new Error("Failed to download media");

    return Buffer.from(await fileRes.arrayBuffer());
  }
}

export const whatsappService = new WhatsAppService();
