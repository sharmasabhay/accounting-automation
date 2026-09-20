import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db/client.js";
import { config } from "../config/index.js";
import { tryGetOrganizationId } from "../context/tenant.js";
import { logger } from "../utils/logger.js";
import type { WhatsAppInboundMessage } from "../types/index.js";

type ConversationChannel = "SUPERVISOR" | "SUPPLIER";

export interface ConversationMessage {
  id: string;
  organizationId: string;
  channel: ConversationChannel;
  direction: "inbound" | "outbound";
  sender: "bot" | "supervisor" | "supplier";
  peer: string;
  text: string;
  supplierId: string | null;
  isGroup?: boolean;
  createdAt: string;
}

function inboundPreview(message: WhatsAppInboundMessage): string {
  if (message.text?.trim()) return message.text;
  if (message.filename) return `[invoice: ${message.filename}]`;
  if (message.type === "image") return "[invoice image]";
  if (message.type === "document") return "[invoice document]";
  return `[${message.type}]`;
}

function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (!digits) return value.replace(/^group:/i, "");
  return value.startsWith("+") ? value : `+${digits}`;
}

function fileFor(organizationId: string): string {
  return path.join(config.conversationsPath, `${organizationId}.jsonl`);
}

async function appendMessage(message: ConversationMessage): Promise<void> {
  await fs.mkdir(config.conversationsPath, { recursive: true, mode: 0o700 });
  await fs.appendFile(fileFor(message.organizationId), `${JSON.stringify(message)}\n`, {
    mode: 0o600,
  });
}

async function readMessages(organizationId: string): Promise<ConversationMessage[]> {
  try {
    const raw = await fs.readFile(fileFor(organizationId), "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ConversationMessage)
      .slice(-200);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

class ConversationService {
  async recordOutbound(to: string, text: string, isGroup = false): Promise<void> {
    const organizationId = tryGetOrganizationId();
    if (!organizationId || !text) return;

    try {
      const classified = await this.classifyPeer(organizationId, to, isGroup);
      await appendMessage({
        id: `msg-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
        organizationId,
        channel: classified.channel,
        direction: "outbound",
        sender: "bot",
        peer: to,
        text,
        supplierId: classified.supplierId,
        isGroup,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      logger.warn({ error }, "Failed to record outbound conversation message");
    }
  }

  async recordInbound(organizationId: string, message: WhatsAppInboundMessage): Promise<void> {
    const text = inboundPreview(message);
    if (!text) return;

    try {
      const isGroup = Boolean(message.isGroup);
      const peer = isGroup ? (message.groupId ?? message.from) : message.from;
      const classified = await this.classifyPeer(organizationId, peer, isGroup);
      await appendMessage({
        id: message.messageId || `msg-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
        organizationId,
        channel: classified.channel,
        direction: "inbound",
        sender: classified.channel === "SUPPLIER" ? "supplier" : "supervisor",
        peer,
        text,
        supplierId: classified.supplierId,
        isGroup,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      logger.warn({ error }, "Failed to record inbound conversation message");
    }
  }

  async list(organizationId: string) {
    const [messages, teamMembers, suppliers] = await Promise.all([
      readMessages(organizationId),
      prisma.teamMember.findMany({
        where: { organizationId, isActive: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.supplier.findMany({
        where: { organizationId, isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, whatsappGroupId: true },
      }),
    ]);

    const supervisor = teamMembers.find((m) => m.role === "SUPERVISOR") ?? teamMembers[0] ?? null;
    const teamPhones = new Set(
      teamMembers.flatMap((m) => {
        const phone = m.phoneNumber;
        return [phone, normalizePhone(phone)];
      })
    );
    const supplierNameById = new Map(suppliers.map((s) => [s.id, s.name]));

    return {
      supervisorPhone: supervisor?.phoneNumber ?? null,
      supervisorName: supervisor?.name ?? null,
      suppliers,
      messages: messages.map((m) => {
        const channel = this.displayChannel(m, teamPhones);
        return {
          ...m,
          channel,
          sender:
            m.sender === "bot"
              ? "bot"
              : channel === "SUPPLIER"
                ? "supplier"
                : "supervisor",
          supplierName: m.supplierId ? (supplierNameById.get(m.supplierId) ?? null) : null,
        };
      }),
    };
  }

  async clear(organizationId: string): Promise<number> {
    const existing = await readMessages(organizationId);
    try {
      await fs.unlink(fileFor(organizationId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return existing.length;
  }

  /**
   * Channel is the conversation window, not "who the phone number looks like".
   * Supervisor DMs stay in the supervisor box even if a supplier's WhatsApp group
   * ID was accidentally set to the same phone number.
   */
  private async classifyPeer(
    organizationId: string,
    peer: string,
    isGroup?: boolean
  ): Promise<{ channel: ConversationChannel; supplierId: string | null }> {
    if (!isGroup) {
      return { channel: "SUPERVISOR", supplierId: null };
    }

    const suppliers = await prisma.supplier.findMany({
      where: { organizationId, isActive: true },
      select: { id: true, whatsappGroupId: true },
    });

    const normalized = peer.replace(/^group:/i, "");
    const supplier = suppliers.find((s) => {
      const groupId = s.whatsappGroupId?.trim();
      if (!groupId) return peer === `group:${s.id}` || normalized === s.id;
      return groupId === peer || groupId === normalized || peer === `group:${groupId}`;
    });

    return { channel: "SUPPLIER", supplierId: supplier?.id ?? null };
  }

  private displayChannel(
    message: ConversationMessage,
    teamPhones: Set<string>
  ): ConversationChannel {
    if (message.isGroup === true) return "SUPPLIER";
    if (message.isGroup === false) return "SUPERVISOR";
    // Legacy rows recorded before isGroup was stored: team DMs belong with the supervisor.
    if (teamPhones.has(message.peer) || teamPhones.has(normalizePhone(message.peer))) {
      return "SUPERVISOR";
    }
    return message.channel;
  }
}

export const conversationService = new ConversationService();
