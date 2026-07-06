import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config/index.js";
import { SYSTEM_PROMPT, PO_PARSE_PROMPT, INVOICE_EXTRACT_PROMPT } from "../prompts/system.js";
import type { ParsedOrderItem, InvoiceExtraction } from "../types/index.js";

class LlmService {
  private client: Anthropic | null = null;

  private getClient(): Anthropic | null {
    if (!config.ANTHROPIC_API_KEY) return null;
    if (!this.client) {
      this.client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    }
    return this.client;
  }

  async parsePurchaseOrder(message: string): Promise<ParsedOrderItem[]> {
    const client = this.getClient();
    if (!client) {
      return this.mockParsePurchaseOrder(message);
    }

    const response = await client.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: `${PO_PARSE_PROMPT}\n\nMessage:\n${message}` },
      ],
    });

    const text = this.extractText(response);
    const parsed = JSON.parse(text) as { items: Array<ParsedOrderItem & { supplier?: string }> };
    return parsed.items.map(({ itemName, quantity, unit }) => ({ itemName, quantity, unit }));
  }

  async refineInvoiceExtraction(ocrText: string): Promise<InvoiceExtraction> {
    const client = this.getClient();
    if (!client) {
      return {
        supplier: { value: "Unknown", confidence: 0.5 },
        invoiceNumber: { value: "UNKNOWN", confidence: 0.5 },
        invoiceDate: { value: new Date().toISOString().slice(0, 10), confidence: 0.5 },
        lineItems: [],
        total: { value: 0, confidence: 0.5 },
      };
    }

    const response = await client.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: `${INVOICE_EXTRACT_PROMPT}\n\nOCR text:\n${ocrText}` },
      ],
    });

    return JSON.parse(this.extractText(response)) as InvoiceExtraction;
  }

  private extractText(response: Anthropic.Messages.Message): string {
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("No text in LLM response");
    return block.text.replace(/```json\n?|\n?```/g, "").trim();
  }

  private mockParsePurchaseOrder(message: string): ParsedOrderItem[] {
    const lines = message
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    return lines.map((line) => {
      const match = line.match(/^[-*]?\s*(.+?):\s*(\d+(?:\.\d+)?)\s*(\w+)?/i);
      if (match) {
        return {
          itemName: match[1]!.trim(),
          quantity: parseFloat(match[2]!),
          unit: match[3],
        };
      }
      return { itemName: line, quantity: 1 };
    });
  }
}

export const llmService = new LlmService();
