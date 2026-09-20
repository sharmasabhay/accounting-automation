import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config/index.js";
import {
  SYSTEM_PROMPT,
  PO_PARSE_PROMPT,
  INVOICE_EXTRACT_PROMPT,
  SOA_EXTRACT_PROMPT,
} from "../prompts/system.js";
import { parsePurchaseOrderLocal } from "../utils/matching.js";
import type {
  ParsedOrderItem,
  ParsePurchaseOrderResult,
  InvoiceExtraction,
  SoaExtraction,
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
    const local = parsePurchaseOrderLocal(message);
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
        supplierName?: string;
      };

      const items = (parsed.items ?? [])
        .filter((item) => item.itemName?.trim() && Number(item.quantity) > 0)
        .map(({ itemName, quantity, unit, supplier }) => ({
          itemName: itemName.trim(),
          quantity: Number(quantity),
          unit: unit ?? undefined,
          supplier: supplier ?? parsed.supplierName ?? undefined,
        }));

      const isPurchaseOrder = Boolean(parsed.isPurchaseOrder) && items.length > 0;

      return {
        isPurchaseOrder,
        items: isPurchaseOrder ? items : [],
        reason: parsed.reason ?? (isPurchaseOrder ? undefined : "Not a purchase order"),
        supplierName: parsed.supplierName ?? items[0]?.supplier,
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

  async extractInvoiceFromPdf(pdfBase64: string): Promise<InvoiceExtraction> {
    const client = this.getClient();
    if (!client) {
      return this.emptyExtraction();
    }

    const response = await client.messages.create(
      {
        model: config.ANTHROPIC_MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: pdfBase64,
                },
              },
              { type: "text", text: INVOICE_EXTRACT_PROMPT },
            ] as Anthropic.Messages.ContentBlockParam[],
          },
        ],
      },
      {
        timeout: 120_000,
        headers: { "anthropic-beta": "pdfs-2024-09-25" },
      }
    );

    return this.parseExtraction(this.extractText(response));
  }

  async extractSoa(rawText: string): Promise<SoaExtraction> {
    const client = this.getClient();
    if (!client) {
      return { invoices: [], balanceDue: 0 };
    }

    const response = await client.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `${SOA_EXTRACT_PROMPT}\n\nDocument:\n${rawText}` }],
    });

    try {
      return JSON.parse(this.extractText(response)) as SoaExtraction;
    } catch {
      return { invoices: [], balanceDue: 0 };
    }
  }

  private parseExtraction(text: string): InvoiceExtraction {
    const cleaned = text.replace(/```json\n?|\n?```/g, "").trim();
    try {
      return JSON.parse(cleaned) as InvoiceExtraction;
    } catch {
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start >= 0 && end > start) {
        return JSON.parse(cleaned.slice(start, end + 1)) as InvoiceExtraction;
      }
      throw new Error("Could not read invoice fields from that PDF. Try a clearer photo instead.");
    }
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
}

export const llmService = new LlmService();
