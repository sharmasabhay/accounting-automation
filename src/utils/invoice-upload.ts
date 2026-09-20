import path from "node:path";
import type { FastifyRequest } from "fastify";
import "@fastify/multipart";

export const MAX_INVOICE_BYTES = 12 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

const ALLOWED_MIME = new Set(Object.values(MIME_BY_EXT));

export interface DecodedInvoiceUpload {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export function mimeFromFilename(filename: string, mimeType?: string): string {
  if (mimeType && mimeType !== "application/octet-stream" && ALLOWED_MIME.has(mimeType)) {
    return mimeType;
  }
  const ext = path.extname(filename).toLowerCase();
  return MIME_BY_EXT[ext] ?? mimeType ?? "application/octet-stream";
}

export function decodeInvoiceUploads(files: unknown): DecodedInvoiceUpload[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Attach at least one invoice photo (JPEG/PNG) or PDF");
  }

  return files.map((file, index) => {
    if (!file || typeof file !== "object") {
      throw new Error(`Attachment ${index + 1} is invalid`);
    }
    const raw = file as { filename?: string; mimeType?: string; contentBase64?: string };
    const filename = raw.filename?.trim() || `invoice-${index + 1}.pdf`;
    const mimeType = mimeFromFilename(filename, raw.mimeType);
    if (!ALLOWED_MIME.has(mimeType)) {
      throw new Error(`${filename}: use a JPEG, PNG, WebP, GIF, or PDF`);
    }
    if (!raw.contentBase64?.trim()) {
      throw new Error(`${filename}: file content is missing`);
    }
    const content = Buffer.from(raw.contentBase64, "base64");
    if (!content.length) {
      throw new Error(`${filename}: file is empty`);
    }
    if (content.length > MAX_INVOICE_BYTES) {
      throw new Error(`${filename} is larger than 12 MB`);
    }
    return { filename, mimeType, content };
  });
}

function assertReadableFile(file: DecodedInvoiceUpload): void {
  if (file.mimeType === "application/pdf") {
    const header = file.content.subarray(0, 5).toString("latin1");
    if (!header.startsWith("%PDF")) {
      throw new Error(
        `${file.filename} is not a valid PDF. Save/export it as PDF again, or upload a JPEG/PNG photo.`
      );
    }
  }
}

export async function readInvoiceUploadRequest(request: FastifyRequest): Promise<{
  files: DecodedInvoiceUpload[];
  fields: Record<string, string>;
}> {
  const contentType = String(request.headers["content-type"] ?? "");
  if (contentType.includes("multipart/form-data")) {
    const files: DecodedInvoiceUpload[] = [];
    const fields: Record<string, string> = {};
    for await (const part of request.parts()) {
      if (part.type === "file") {
        const content = await part.toBuffer();
        const filename = part.filename || `invoice-${files.length + 1}.pdf`;
        const mimeType = mimeFromFilename(filename, part.mimetype);
        if (!ALLOWED_MIME.has(mimeType)) {
          throw new Error(`${filename}: use a JPEG, PNG, WebP, GIF, or PDF`);
        }
        if (!content.length) throw new Error(`${filename}: file is empty`);
        if (content.length > MAX_INVOICE_BYTES) {
          throw new Error(`${filename} is larger than 12 MB`);
        }
        const file = { filename, mimeType, content };
        assertReadableFile(file);
        files.push(file);
        continue;
      }
      if (typeof part.value === "string" && part.value.trim()) {
        fields[part.fieldname] = part.value.trim();
      }
    }
    if (!files.length) {
      throw new Error("Attach at least one invoice photo (JPEG/PNG) or PDF");
    }
    return { files, fields };
  }

  const body = (request.body ?? {}) as {
    files?: unknown;
    from?: string;
    subject?: string;
    kind?: string;
  };
  const files = decodeInvoiceUploads(body.files);
  for (const file of files) assertReadableFile(file);
  return {
    files,
    fields: {
      ...(body.from ? { from: body.from } : {}),
      ...(body.subject ? { subject: body.subject } : {}),
      ...(body.kind ? { kind: body.kind } : {}),
    },
  };
}
