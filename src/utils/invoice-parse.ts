import type { InvoiceExtraction, LineItemExtraction } from "../types/index.js";

const SKIP_SUPPLIER =
  /^(invoice|tax invoice|supplier invoice|purchase order|tax|bill|bill to|receipt|statement|page|tel|fax|email|gst|uen|date|total|qty|item|description|amount|supplier|invoice details)$/i;

const HEADERISH =
  /supplier invoice|invoice details|bill to|purchase order|delivery date|payment details|amount in words/i;

const UNITS = "kg|g|pcs?|pkt|pack|box|bunches?|l|ml";

const DATE =
  "\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{2,4}|\\d{1,2}\\s+[A-Za-z]{3,9}\\s+\\d{2,4}";

const MONTHS: Record<string, string> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

function field<T>(value: T, confidence: number) {
  return { value, confidence };
}

function parseMoney(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

function columns(line: string): string[] {
  return line
    .split(/\s{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeDate(raw: string): string {
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return raw;

  const named = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})$/);
  if (named) {
    const month = MONTHS[named[2]!.toLowerCase()];
    if (month) {
      let year = named[3]!;
      if (year.length === 2) year = `20${year}`;
      return `${year}-${month}-${named[1]!.padStart(2, "0")}`;
    }
  }

  const slash = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!slash) return new Date().toISOString().slice(0, 10);

  const day = slash[1]!.padStart(2, "0");
  const month = slash[2]!.padStart(2, "0");
  let year = slash[3]!;
  if (year.length === 2) year = `20${year}`;
  return `${year}-${month}-${day}`;
}

function extractSupplier(rawText: string, lines: string[]): { value: string; confidence: number } {
  const rawLines = rawText.replace(/\r/g, "").split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const cols = columns(rawLines[i]!);
    if (!cols[0] || !/^supplier$/i.test(cols[0])) continue;
    for (let j = i + 1; j < Math.min(i + 6, rawLines.length); j++) {
      const next = columns(rawLines[j]!);
      const name = next[0]?.replace(/^[\s|*•-]+/, "").trim();
      if (!name || name.length < 3 || SKIP_SUPPLIER.test(name)) continue;
      if (/^(address|gst|invoice|po\b)/i.test(name)) continue;
      return field(name.replace(/\s+/g, " "), 0.9);
    }
  }

  for (const line of lines.slice(0, 12)) {
    const cleaned = line.replace(/^[\s|*•-]+/, "").trim();
    if (cleaned.length < 3 || SKIP_SUPPLIER.test(cleaned) || HEADERISH.test(cleaned)) continue;
    if (/^invoice\s*(number|no|#)/i.test(cleaned)) continue;
    if (/^\d/.test(cleaned)) continue;
    const stop = cleaned.search(/\b(invoice|bill to|address|gst|date|po no)\b/i);
    const name = (stop > 0 ? cleaned.slice(0, stop) : cleaned).trim();
    if (name.length < 3) continue;
    const confidence = /(?:pte\.?\s*ltd|ltd|llc|inc|sdn|bhd)/i.test(name) ? 0.92 : 0.8;
    return field(name.replace(/\s+/g, " "), confidence);
  }
  return field("unknown", 0.2);
}

function extractPoNumber(text: string): string | null {
  const labelled = text.match(
    /\bPO\s*(?:number|no\.?|#)\s*[:.\-]?\s*(PO[-/]?[A-Z0-9][-A-Z0-9/]*)/i
  );
  if (labelled?.[1]) return labelled[1].trim();
  const compact = text.match(/\b(PO-\d{4}-\d+)\b/i);
  return compact?.[1] ?? null;
}

function extractInvoiceNumber(text: string, filename?: string): { value: string; confidence: number } {
  const labelled = text.match(
    /invoice\s*(?:number|no\.?|#)\s*[:.\-]?\s*([A-Z0-9][A-Z0-9][-A-Z0-9/]{1,})/i
  );
  if (labelled?.[1] && !/^[_-]+$/.test(labelled[1]) && !/^(address|gst|date|total|supplier|invoice|details|item|qty)$/i.test(labelled[1])) {
    return field(labelled[1].trim(), 0.93);
  }

  const compact = text.match(/\b(INV[-/][A-Z0-9][-A-Z0-9/]*)\b/i);
  if (compact?.[1]) return field(compact[1].trim(), 0.85);

  const po = extractPoNumber(text) ?? filename?.match(/\b(PO-\d{4}-\d+)\b/i)?.[1];
  if (po) return field(po, 0.8);

  return field("unknown", 0.2);
}

function extractInvoiceDate(text: string): { value: string; confidence: number } {
  const labelled = text.match(new RegExp(`invoice\\s*date\\s*[:.\\-]?\\s*(${DATE})`, "i"));
  if (labelled?.[1]) return field(normalizeDate(labelled[1]), 0.9);

  const generic = text.match(
    new RegExp(`(?<!purchase\\s+order\\s)(?<!delivery\\s)(?<!order\\s)date\\s*[:.\\-]?\\s*(${DATE})`, "i")
  );
  if (generic?.[1]) return field(normalizeDate(generic[1]), 0.75);

  const loose = text.match(new RegExp(`\\b(${DATE})\\b`));
  if (loose?.[1]) return field(normalizeDate(loose[1]), 0.7);

  return field(new Date().toISOString().slice(0, 10), 0.4);
}

function extractTotal(text: string): { value: number; confidence: number } {
  const matches = [
    ...text.matchAll(
      /(?:grand\s*total|amount\s*due|balance\s*due|total(?:\s+amount)?)\s*[:.\-]?\s*(?:s\$|sgd|\$)?\s*([\d,]+(?:\.\d{1,2})?)/gi
    ),
  ];
  const last = matches.at(-1)?.[1];
  if (last) return field(parseMoney(last), 0.92);
  return field(0, 0.2);
}

function looksLikeHeader(line: string): boolean {
  return (
    /^(item|description|qty|quantity|amount|unit|price|total|#)\b/i.test(line) ||
    (/\bitem\b/i.test(line) && /\bqty\b/i.test(line)) ||
    (/\bdescription\b/i.test(line) && /\bqty\b/i.test(line))
  );
}

function parseTableRow(line: string): { name: string; quantity: number; unitAmount: number } | null {
  const match = line.match(
    /^(?:\d+\s+)?(.+?)\s+(\d+(?:\.\d+)?)\s+([\d,]+(?:\.\d{1,2})?)\s+(?:(\d+(?:\.\d+)?)\s*%?\s+)?([\d,]+(?:\.\d{1,2})?)\s*$/i
  );
  if (!match) return null;
  const name = match[1]!.replace(/^[-*•]\s*/, "").trim();
  const quantity = Number(match[2]);
  const unitAmount = parseMoney(match[3]!);
  const lineTotal = parseMoney(match[5]!);
  if (!name || /invoice|subtotal|total|tax\b/i.test(name) || SKIP_SUPPLIER.test(name)) return null;
  if (!(quantity > 0) || !(unitAmount > 0) || !(lineTotal > 0)) return null;
  if (Math.abs(quantity * unitAmount - lineTotal) > 0.05) {
    return { name, quantity, unitAmount: Math.round((lineTotal / quantity) * 100) / 100 };
  }
  return { name, quantity, unitAmount };
}

function parseLineItems(lines: string[], invoiceTotal: number): LineItemExtraction[] {
  const itemPattern = new RegExp(
    `^(.{2,80}?)\\s+(\\d+(?:\\.\\d+)?)\\s*(${UNITS})?\\s+(?:s\\$|sgd|\\$)?\\s*([\\d,]+(?:\\.\\d{1,2})?)\\s*$`,
    "i"
  );

  const tableRows: Array<{ name: string; quantity: number; unitAmount: number }> = [];
  const candidates: Array<{ name: string; quantity: number; amount: number }> = [];

  for (const line of lines) {
    if (looksLikeHeader(line) || /^(total|grand total|amount due|subtotal)\b/i.test(line)) continue;
    const table = parseTableRow(line);
    if (table) {
      tableRows.push(table);
      continue;
    }
    const match = line.match(itemPattern);
    if (!match) continue;
    const name = match[1]!.replace(/^[-*•]\s*/, "").trim();
    if (!name || SKIP_SUPPLIER.test(name) || /invoice/i.test(name)) continue;
    const quantity = Number(match[2]);
    const amount = parseMoney(match[4]!);
    if (!(quantity > 0) || !(amount > 0)) continue;
    candidates.push({ name, quantity, amount });
  }

  if (tableRows.length) {
    return tableRows.map((row) => ({
      name: field(row.name, 0.88),
      quantity: field(row.quantity, 0.92),
      unitAmount: field(row.unitAmount, 0.9),
    }));
  }

  if (!candidates.length) return [];

  const asLineTotals = candidates.reduce((sum, row) => sum + row.amount, 0);
  const asUnitPrices = candidates.reduce((sum, row) => sum + row.quantity * row.amount, 0);
  const useUnitPrices =
    invoiceTotal > 0 &&
    Math.abs(asUnitPrices - invoiceTotal) + 0.05 < Math.abs(asLineTotals - invoiceTotal);

  return candidates.map((row) => {
    const unitAmount = useUnitPrices ? row.amount : row.amount / row.quantity;
    return {
      name: field(row.name, 0.82),
      quantity: field(row.quantity, 0.9),
      unitAmount: field(Math.round(unitAmount * 100) / 100, 0.8),
    };
  });
}

export function parseInvoiceText(rawText: string, filename?: string): InvoiceExtraction {
  const text = rawText.replace(/\r/g, "").trim();
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const supplier = extractSupplier(text, lines);
  const namedPo =
    extractPoNumber(text) ?? filename?.match(/\b(PO-\d{4}-\d+)\b/i)?.[1] ?? null;
  const invoiceNumber = extractInvoiceNumber(text, filename);
  const invoiceDate = extractInvoiceDate(text);
  const total = extractTotal(text);
  const lineItems = parseLineItems(lines, total.value);
  const signedOrStamped = /signature|signed|chop|stamp|company seal/i.test(text);

  if (lineItems.length && total.confidence < 0.5) {
    const summed = lineItems.reduce(
      (sum, line) => sum + line.quantity.value * line.unitAmount.value,
      0
    );
    total.value = Math.round(summed * 100) / 100;
    total.confidence = 0.7;
  }

  return {
    supplier,
    invoiceNumber,
    invoiceDate,
    lineItems,
    total,
    signedOrStamped,
    poNumber: namedPo ? field(namedPo, 0.9) : undefined,
  };
}

export function textLooksUsable(text: string): boolean {
  const words = text.split(/\s+/).filter((word) => word.length > 1);
  return words.length >= 6;
}

export function hasCoreInvoiceFields(extraction: InvoiceExtraction): boolean {
  const supplier = extraction.supplier.value.trim().toLowerCase();
  const hasSupplier = supplier.length > 0 && supplier !== "unknown";
  return hasSupplier && (extraction.total.value > 0 || extraction.lineItems.length > 0);
}
