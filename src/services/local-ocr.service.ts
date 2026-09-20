import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createWorker } from "tesseract.js";
import { extractText, getDocumentProxy } from "unpdf";
import { logger } from "../utils/logger.js";
import { parseInvoiceText, textLooksUsable } from "../utils/invoice-parse.js";
import type { InvoiceExtraction } from "../types/index.js";

const execFileAsync = promisify(execFile);

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".tif", ".tiff", ".bmp"]);

class LocalOcrService {
  private worker: Awaited<ReturnType<typeof createWorker>> | null = null;
  private workerLoading: Promise<Awaited<ReturnType<typeof createWorker>>> | null = null;

  async extract(
    filePath: string,
    mimeType?: string
  ): Promise<{ rawText: string; extraction: InvoiceExtraction }> {
    const rawText = await this.readText(filePath, mimeType);
    const extraction = parseInvoiceText(rawText, path.basename(filePath));
    logger.info(
      {
        file: path.basename(filePath),
        supplier: extraction.supplier.value,
        invoiceNumber: extraction.invoiceNumber.value,
        total: extraction.total.value,
        lines: extraction.lineItems.length,
      },
      "Invoice extracted with local OCR"
    );
    return { rawText, extraction };
  }

  private async readText(filePath: string, mimeType?: string): Promise<string> {
    const ext = path.extname(filePath).toLowerCase();
    const isPdf = mimeType === "application/pdf" || ext === ".pdf";
    if (isPdf) return this.readPdf(filePath);
    if (IMAGE_EXT.has(ext) || mimeType?.startsWith("image/")) {
      return this.readImage(filePath);
    }
    throw new Error(
      `Unsupported invoice file type (${mimeType ?? (ext || "unknown")}). Send a JPEG, PNG, or PDF.`
    );
  }

  private async readPdf(filePath: string): Promise<string> {
    const fromPoppler = await this.pdftotext(filePath);
    if (fromPoppler && textLooksUsable(fromPoppler)) return fromPoppler;

    const fromUnpdf = await this.unpdfText(filePath);
    if (fromUnpdf && textLooksUsable(fromUnpdf)) return fromUnpdf;

    const scanned = await this.ocrScannedPdf(filePath);
    if (scanned && textLooksUsable(scanned)) return scanned;

    return fromPoppler || fromUnpdf || scanned || "";
  }

  private async pdftotext(filePath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("pdftotext", ["-layout", "-q", filePath, "-"], {
        timeout: 30_000,
        maxBuffer: 5 * 1024 * 1024,
      });
      return stdout.trim();
    } catch {
      return null;
    }
  }

  private async unpdfText(filePath: string): Promise<string | null> {
    try {
      const buffer = await fs.readFile(filePath);
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractText(pdf, { mergePages: true });
      const joined = Array.isArray(text) ? text.join("\n") : text;
      return joined.trim();
    } catch (error) {
      logger.warn({ err: error, filePath }, "unpdf text extract failed");
      return null;
    }
  }

  private async ocrScannedPdf(filePath: string): Promise<string | null> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omakase-ocr-"));
    try {
      await execFileAsync(
        "pdftoppm",
        ["-png", "-f", "1", "-l", "3", "-r", "200", filePath, path.join(tmpDir, "page")],
        { timeout: 45_000 }
      );
      const pages = (await fs.readdir(tmpDir))
        .filter((name) => name.endsWith(".png"))
        .sort()
        .map((name) => path.join(tmpDir, name));
      if (!pages.length) return null;

      const chunks: string[] = [];
      for (const page of pages) {
        chunks.push(await this.readImage(page));
      }
      return chunks.join("\n").trim();
    } catch {
      return null;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async readImage(filePath: string): Promise<string> {
    const worker = await this.getWorker();
    const result = await worker.recognize(filePath);
    return result.data.text.trim();
  }

  private async getWorker(): Promise<Awaited<ReturnType<typeof createWorker>>> {
    if (this.worker) return this.worker;
    if (!this.workerLoading) {
      this.workerLoading = createWorker("eng")
        .then((worker) => {
          this.worker = worker;
          return worker;
        })
        .catch((error) => {
          this.workerLoading = null;
          logger.error({ err: error }, "Tesseract worker failed to start");
          throw error;
        });
    }
    return this.workerLoading;
  }
}

export const localOcrService = new LocalOcrService();
