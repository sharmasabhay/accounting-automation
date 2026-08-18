import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config/index.js";
import { SYSTEM_PROMPT, PO_PARSE_PROMPT, INVOICE_EXTRACT_PROMPT } from "../prompts/system.js";
import type {
  ParsedOrderItem,
  ParsePurchaseOrderResult,
  InvoiceExtraction,
} from "../types/index.js";

class LlmService {
  private client: Anthropic | null = null;

  private getClient(): Anthropic | null {
    if (!config.ANTHROPIC_API_KEY) return null;
    if (!this.client) {
      this.client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    }
    return this.client;
  }

  async parsePurchaseOrder(message: string): Promise<ParsePurchaseOrderResult> {
    // Prefer deterministic format parsing for the documented "Item: qty unit" lines.
    // This must work even when the Anthropic API key is missing or invalid.
    const local = this.parseFormattedPurchaseOrder(message);
    if (local.isPurchaseOrder) {
      return local;
    }

    const client = this.getClient();
    if (!client) {
      return local;
    }

    try {
      const response = await client.messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          { role: "user", content: `${PO_PARSE_PROMPT}\n\nMessage:\n${message}` },
        ],
      });

      const text = this.extractText(response);
      const parsed = JSON.parse(text) as {
        isPurchaseOrder?: boolean;
        items?: Array<ParsedOrderItem & { supplier?: string }>;
        reason?: string;
      };

      const items = (parsed.items ?? [])
        .filter((item) => item.itemName?.trim() && Number(item.quantity) > 0)
        .map(({ itemName, quantity, unit }) => ({
          itemName: itemName.trim(),
          quantity: Number(quantity),
          unit: unit ?? undefined,
        }));

      const isPurchaseOrder = Boolean(parsed.isPurchaseOrder) && items.length > 0;

      return {
        isPurchaseOrder,
        items: isPurchaseOrder ? items : [],
        reason: parsed.reason ?? (isPurchaseOrder ? undefined : "Not a purchase order"),
      };
    } catch {
      // Fall back to local result (usually empty) instead of failing the whole PO flow
      return {
        ...local,
        reason: local.reason ?? "AI parse unavailable; no item: quantity lines found",
      };
    }
  }

  async refineInvoiceExtraction(ocrText: string): Promise<InvoiceExtraction> {
    const client = this.getClient();
    if (!client) {
      return this.emptyExtraction();
    }

    const response = await client.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: `${INVOICE_EXTRACT_PROMPT}\n\nOCR text:\n${ocrText}` },
      ],
    });

    return this.parseExtraction(this.extractText(response));
  }

  async extractInvoiceFromImage(
    imageBase64: string,
    mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
  ): Promise<InvoiceExtraction> {
    const client = this.getClient();
    if (!client) {
      return this.emptyExtraction();
    }

    const response = await client.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mimeType, data: imageBase64 },
            },
            { type: "text", text: INVOICE_EXTRACT_PROMPT },
          ],
        },
      ],
    });

    return this.parseExtraction(this.extractText(response));
  }

  private parseExtraction(text: string): InvoiceExtraction {
    return JSON.parse(text) as InvoiceExtraction;
  }

  private emptyExtraction(): InvoiceExtraction {
    return {
      supplier: { value: "Unknown", confidence: 0.3 },
      invoiceNumber: { value: "UNKNOWN", confidence: 0.3 },
      invoiceDate: { value: new Date().toISOString().slice(0, 10), confidence: 0.3 },
      lineItems: [],
      total: { value: 0, confidence: 0.3 },
    };
  }

  private extractText(response: Anthropic.Messages.Message): string {
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("No text in LLM response");
    return block.text.replace(/```json\n?|\n?```/g, "").trim();
  }

  private parseFormattedPurchaseOrder(message: string): ParsePurchaseOrderResult {
    const lines = message
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const items: ParsedOrderItem[] = [];

    for (const line of lines) {
      // Matches:
      // - Bok choy: 10 kg
      // * Zucchini: 40kg
      // Item1: 5
      const match = line.match(
        /^[-*•]?\s*(.+?)\s*:\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?\s*$/i
      );
      if (!match) continue;

      const itemName = match[1]!.trim();
      const quantity = parseFloat(match[2]!);
      if (!itemName || !(quantity > 0)) continue;

      // Ignore help-like fake "items"
      if (/^(help|hi|hello|yes|no|ready|approve)$/i.test(itemName)) continue;

      items.push({
        itemName,
        quantity,
        unit: match[3] || undefined,
      });
    }

    return {
      isPurchaseOrder: items.length > 0,
      items,
      reason:
        items.length > 0
          ? "Matched item: quantity format"
          : "No item: quantity lines found",
    };
  }
}

export const llmService = new LlmService();
