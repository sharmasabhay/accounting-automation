import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/storage.js";
import { llmService } from "./llm.service.js";
import type { InvoiceExtraction } from "../types/index.js";

const IMAGE_MIME_BY_EXT: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

class OcrService {
  async extractFromFile(
    filePath: string,
    mimeType?: string
  ): Promise<{
    rawText: string;
    extraction: InvoiceExtraction;
  }> {
    const useMock =
      config.OCR_PROVIDER === "mock" && !config.ANTHROPIC_API_KEY;

    if (useMock) {
      logger.warn(
        "OCR_PROVIDER=mock and no ANTHROPIC_API_KEY — using fixed Fresh Farms sample data"
      );
      return this.mockExtraction();
    }

    if (config.ANTHROPIC_API_KEY) {
      return withRetry(() => this.extractWithClaudeVision(filePath, mimeType), {
        label: "ocr.claude-vision",
      });
    }

    logger.warn(
      { provider: config.OCR_PROVIDER },
      "OCR provider not fully configured — falling back to mock"
    );
    return this.mockExtraction();
  }

  private async extractWithClaudeVision(
    filePath: string,
    mimeType?: string
  ): Promise<{ rawText: string; extraction: InvoiceExtraction }> {
    const buffer = await fs.readFile(filePath);
    const resolvedMime = this.resolveImageMime(filePath, mimeType);

    if (!resolvedMime) {
      const kind = mimeType ?? (path.extname(filePath) || "unknown");
      throw new Error(
        `Unsupported invoice file type (${kind}). Please send a clear JPEG or PNG photo of the invoice.`
      );
    }

    const extraction = await llmService.extractInvoiceFromImage(
      buffer.toString("base64"),
      resolvedMime
    );

    logger.info(
      {
        supplier: extraction.supplier.value,
        invoiceNumber: extraction.invoiceNumber.value,
        total: extraction.total.value,
        supplierConfidence: extraction.supplier.confidence,
      },
      "Invoice extracted via Claude vision"
    );

    return {
      rawText: `Claude vision extraction for ${path.basename(filePath)}`,
      extraction,
    };
  }

  private resolveImageMime(
    filePath: string,
    mimeType?: string
  ): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null {
    if (
      mimeType === "image/jpeg" ||
      mimeType === "image/png" ||
      mimeType === "image/gif" ||
      mimeType === "image/webp"
    ) {
      return mimeType;
    }

    const ext = path.extname(filePath).toLowerCase();
    return IMAGE_MIME_BY_EXT[ext] ?? null;
  }

  private mockExtraction(): { rawText: string; extraction: InvoiceExtraction } {
    const extraction: InvoiceExtraction = {
      supplier: { value: "Fresh Farms Pte Ltd", confidence: 0.95 },
      invoiceNumber: { value: "INV-2026-0001", confidence: 0.98 },
      invoiceDate: { value: "2026-06-01", confidence: 0.97 },
      lineItems: [
        {
          name: { value: "Bok Choy", confidence: 0.9 },
          quantity: { value: 10, confidence: 0.95 },
          unitAmount: { value: 3.5, confidence: 0.92 },
        },
      ],
      total: { value: 35.0, confidence: 0.96 },
      signedOrStamped: true,
    };

    return {
      rawText: "Mock OCR output for development",
      extraction,
    };
  }
}

export const ocrService = new OcrService();
