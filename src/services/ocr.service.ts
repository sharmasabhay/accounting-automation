import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/storage.js";
import type { InvoiceExtraction } from "../types/index.js";

class OcrService {
  async extractFromFile(_filePath: string, _mimeType?: string): Promise<{
    rawText: string;
    extraction: InvoiceExtraction;
  }> {
    if (config.OCR_PROVIDER === "mock") {
      return this.mockExtraction();
    }

    return withRetry(async () => {
      logger.warn("OCR provider not fully configured — falling back to mock");
      return this.mockExtraction();
    }, { label: "ocr.extract" });
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
