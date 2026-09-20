import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/storage.js";
import { llmService } from "./llm.service.js";
import { integrationConfigService } from "./integration-config.service.js";
import { localOcrService } from "./local-ocr.service.js";
import { getOrganizationId } from "../context/tenant.js";
import { hasCoreInvoiceFields } from "../utils/invoice-parse.js";
import type { InvoiceExtraction } from "../types/index.js";

const IMAGE_MIME_BY_EXT: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const CONFIDENCE_THRESHOLD = 0.75;

function minFieldConfidence(extraction: InvoiceExtraction): number {
  const fields = [
    extraction.supplier.confidence,
    extraction.invoiceNumber.confidence,
    extraction.total.confidence,
  ];
  return Math.min(...fields);
}

class OcrService {
  async extractFromFile(
    filePath: string,
    mimeType?: string
  ): Promise<{
    rawText: string;
    extraction: InvoiceExtraction;
  }> {
    const provider = await this.resolveProvider();
    let local: { rawText: string; extraction: InvoiceExtraction } | null = null;

    if (provider !== "claude") {
      try {
        local = await localOcrService.extract(filePath, mimeType);
        if (
          hasCoreInvoiceFields(local.extraction) ||
          minFieldConfidence(local.extraction) >= CONFIDENCE_THRESHOLD
        ) {
          return local;
        }
      } catch (error) {
        logger.warn({ err: error }, "Local OCR failed");
      }
    }

    if (local && config.ANTHROPIC_API_KEY && !hasCoreInvoiceFields(local.extraction)) {
      try {
        const refined = await llmService.refineInvoiceExtraction(local.rawText);
        if (
          hasCoreInvoiceFields(refined) &&
          minFieldConfidence(refined) > minFieldConfidence(local.extraction)
        ) {
          return { rawText: local.rawText, extraction: refined };
        }
      } catch (error) {
        logger.warn({ err: error }, "Claude text refine failed — keeping local OCR");
      }
    }

    if (local) return local;

    if (!config.ANTHROPIC_API_KEY) {
      throw new Error(
        "Could not read that invoice with local OCR (Tesseract / Poppler). Send a clearer PDF or photo."
      );
    }

    return withRetry(() => this.extractWithClaude(filePath, mimeType), {
      label: "ocr.claude-vision",
      maxAttempts: 2,
      delaysMs: [2000],
    });
  }

  private async resolveProvider(): Promise<string> {
    let provider = config.OCR_PROVIDER;
    try {
      const ocr = await integrationConfigService.getOcr(getOrganizationId());
      if (ocr.provider) provider = ocr.provider;
    } catch {
      /* no org context */
    }
    return provider;
  }

  private async extractWithClaude(
    filePath: string,
    mimeType?: string
  ): Promise<{ rawText: string; extraction: InvoiceExtraction }> {
    const buffer = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const isPdf = mimeType === "application/pdf" || ext === ".pdf";

    if (isPdf) {
      logger.info({ file: path.basename(filePath), bytes: buffer.length }, "Reading invoice PDF with Claude");
      const extraction = await llmService.extractInvoiceFromPdf(buffer.toString("base64"));
      return {
        rawText: `Claude PDF extraction for ${path.basename(filePath)}`,
        extraction,
      };
    }

    const resolvedMime = this.resolveImageMime(filePath, mimeType);
    if (!resolvedMime) {
      const kind = mimeType ?? (ext || "unknown");
      throw new Error(
        `Unsupported invoice file type (${kind}). Please send a clear JPEG, PNG, or PDF of the invoice.`
      );
    }

    const extraction = await llmService.extractInvoiceFromImage(
      buffer.toString("base64"),
      resolvedMime
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
}

export const ocrService = new OcrService();
