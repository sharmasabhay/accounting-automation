import type {
  ParsedOrderItem,
  ParsePurchaseOrderResult,
  SoaCompareBucketItem,
  SoaCompareResult,
} from "../types/index.js";

export const TOTAL_TOLERANCE = 0.1;
export const PO_MATCH_WINDOW_DAYS = 10;

export function normalizeItemName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function namesMatch(a: string, b: string): boolean {
  const na = normalizeItemName(a);
  const nb = normalizeItemName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

const CATALOG_UNITS = /\b(kgs?|grams?|g|pcs?|pkt|packs?|boxes|box|bunches?|bunch|litres?|l|ml)\b/gi;

export function catalogLookupName(name: string): string {
  return normalizeItemName(name)
    .replace(CATALOG_UNITS, " ")
    .replace(/[\-_\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function catalogItemMatches(query: string, itemName: string, itemCode?: string): boolean {
  const q = catalogLookupName(query);
  const n = catalogLookupName(itemName);
  const code = catalogLookupName(itemCode ?? "");
  if (!q) return false;
  if (q === n || (code && q === code)) return true;
  if (n.includes(q) || q.includes(n)) return true;
  if (code && (code.includes(q) || q.includes(code))) return true;
  const compact = (value: string) => value.replace(/\s+/g, "");
  if (compact(q) === compact(n)) return true;
  const qTokens = q.split(" ").filter((token) => token.length > 1);
  const nTokens = n.split(" ");
  return (
    qTokens.length > 0 &&
    qTokens.every((token) => nTokens.some((part) => part === token || part.includes(token) || token.includes(part)))
  );
}

export function quantitiesMatch(invoiceQty: number, poQty: number): boolean {
  return Math.abs(invoiceQty - poQty) < 1e-6;
}

export function totalsMatch(
  invoiceTotal: number,
  poTotal: number,
  tolerance = TOTAL_TOLERANCE
): boolean {
  return Math.abs(invoiceTotal - poTotal) <= tolerance + 1e-9;
}

export function isWithinDaysBefore(
  poDate: Date,
  invoiceDate: Date,
  days = PO_MATCH_WINDOW_DAYS
): boolean {
  const invoice = new Date(invoiceDate);
  invoice.setHours(23, 59, 59, 999);
  const windowStart = new Date(invoiceDate);
  windowStart.setDate(windowStart.getDate() - days);
  windowStart.setHours(0, 0, 0, 0);
  const po = new Date(poDate);
  return po.getTime() >= windowStart.getTime() && po.getTime() <= invoice.getTime();
}

export function isSoaDocument(filename?: string, subject?: string): boolean {
  const hay = `${filename ?? ""} ${subject ?? ""}`.toLowerCase();
  return /\bsoa\b|statement of account|\bstatement\b/.test(hay);
}

const HELP_ITEM = /^(help|hi|hello|yes|no|ready|approve)$/i;

export function parseColonPurchaseOrder(message: string): ParsePurchaseOrderResult {
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const items: ParsedOrderItem[] = [];

  for (const line of lines) {
    const match = line.match(
      /^[-*•]?\s*(.+?)\s*:\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?\s*$/i
    );
    if (!match) continue;

    const itemName = match[1]!.trim();
    const quantity = parseFloat(match[2]!);
    if (!itemName || !(quantity > 0)) continue;
    if (HELP_ITEM.test(itemName)) continue;

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

const FREEFORM_ITEM =
  /^[-*•]?\s*(.+?)\s+(\d+(?:\.\d+)?)\s*(kg|g|pcs?|pkt|pack|box|bunches?|l|ml)?\s*$/i;

export function parseFreeformPurchaseOrder(message: string): ParsePurchaseOrderResult {
  const chunks = message
    .split(/[\n,;]+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  const items: ParsedOrderItem[] = [];

  for (const chunk of chunks) {
    const match = chunk.match(FREEFORM_ITEM);
    if (!match) continue;

    const itemName = match[1]!.replace(/^[-*•]\s*/, "").trim();
    const quantity = parseFloat(match[2]!);
    if (!itemName || !(quantity > 0) || HELP_ITEM.test(itemName)) continue;
    if (itemName.split(/\s+/).length > 8) continue;

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
        ? "Matched freeform item quantity"
        : "No freeform item quantities found",
  };
}

export function parsePurchaseOrderLocal(message: string): ParsePurchaseOrderResult {
  const colon = parseColonPurchaseOrder(message);
  if (colon.isPurchaseOrder) return colon;
  return parseFreeformPurchaseOrder(message);
}

export function isRestartCommand(text: string): boolean {
  const trimmed = text.trim();
  return /^(restart|cancel|start over|start again|new order|new po|stop|abort|nevermind|never mind)\s*!*$/i.test(
    trimmed
  );
}

export function looksLikeReconcileRequest(text: string): boolean {
  return /\b(reconcile|statement of account|\bsoa\b)\b/i.test(text);
}

export function looksLikeSupplierChange(text: string): boolean {
  return /\b(change|switch|different|another|other)\s+suppliers?\b/i.test(text.trim());
}

export function looksLikeNewPurchaseOrder(text: string): boolean {
  const parsed = parsePurchaseOrderLocal(text);
  if (!parsed.isPurchaseOrder) return false;
  if (parsed.items.length >= 2) return true;
  const only = parsed.items[0];
  return Boolean(only?.unit);
}

export interface MatchableLine {
  name: string;
  quantity: number;
  unitAmount?: number;
}

export interface InvoicePoMatchResult {
  ok: boolean;
  quantityMismatch: boolean;
  amountMismatch: boolean;
  unmatchedInvoiceLines: string[];
  unmatchedPoLines: string[];
  invoiceTotal: number;
  poTotal: number;
}

export function matchInvoiceToPo(
  invoiceLines: MatchableLine[],
  poLines: MatchableLine[],
  invoiceTotal: number,
  poTotal?: number
): InvoicePoMatchResult {
  const remaining = poLines.map((line) => ({ ...line, used: false }));
  const unmatchedInvoiceLines: string[] = [];

  let quantityMismatch = false;

  for (const invoiceLine of invoiceLines) {
    const poLine = remaining.find(
      (candidate) => !candidate.used && namesMatch(candidate.name, invoiceLine.name)
    );
    if (!poLine) {
      unmatchedInvoiceLines.push(invoiceLine.name);
      continue;
    }
    poLine.used = true;
    if (!quantitiesMatch(invoiceLine.quantity, poLine.quantity)) {
      quantityMismatch = true;
    }
  }

  const unmatchedPoLines = remaining.filter((line) => !line.used).map((line) => line.name);
  const resolvedPoTotal =
    poTotal ??
    poLines.reduce((sum, line) => sum + line.quantity * (line.unitAmount ?? 0), 0);
  const invoiceLineSum = invoiceLines.reduce(
    (sum, line) => sum + line.quantity * (line.unitAmount ?? 0),
    0
  );
  const gstInclusivePoTotal = Math.round(resolvedPoTotal * 1.09 * 100) / 100;
  const amountMismatch =
    !totalsMatch(invoiceTotal, resolvedPoTotal) &&
    !totalsMatch(invoiceLineSum, resolvedPoTotal) &&
    !totalsMatch(invoiceTotal, gstInclusivePoTotal);

  return {
    ok:
      unmatchedInvoiceLines.length === 0 &&
      unmatchedPoLines.length === 0 &&
      !quantityMismatch &&
      !amountMismatch,
    quantityMismatch,
    amountMismatch,
    unmatchedInvoiceLines,
    unmatchedPoLines,
    invoiceTotal,
    poTotal: resolvedPoTotal,
  };
}

export function poNumbersMatch(a: string, b: string): boolean {
  const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, "");
  return Boolean(a) && Boolean(b) && norm(a) === norm(b);
}

export interface InvoicePoCandidate {
  localId?: string;
  xeroPoId?: string;
  poNumber: string;
  lines: MatchableLine[];
  total: number;
}

export type InvoicePoSelection =
  | { status: "matched"; candidate: InvoicePoCandidate; match: InvoicePoMatchResult }
  | { status: "named-mismatch"; candidate: InvoicePoCandidate; match: InvoicePoMatchResult }
  | { status: "ambiguous"; candidates: InvoicePoCandidate[] }
  | { status: "none" };

export function namedPoFromInvoice(invoiceNumber?: string, poNumber?: string): string | undefined {
  const named = poNumber?.trim() || invoiceNumber?.trim();
  if (!named) return undefined;
  if (/^PO[-/\s]?\d/i.test(named) || /^PO[-/]/i.test(named)) return named;
  return poNumber?.trim() || undefined;
}

export function selectInvoicePurchaseOrder(
  invoiceLines: MatchableLine[],
  invoiceTotal: number,
  candidates: InvoicePoCandidate[],
  namedPoNumber?: string
): InvoicePoSelection {
  if (!candidates.length) return { status: "none" };

  const named = namedPoNumber
    ? candidates.find((candidate) => poNumbersMatch(candidate.poNumber, namedPoNumber))
    : undefined;

  if (named) {
    const match = matchInvoiceToPo(invoiceLines, named.lines, invoiceTotal, named.total);
    if (match.ok) return { status: "matched", candidate: named, match };
    return { status: "named-mismatch", candidate: named, match };
  }

  const hits = candidates
    .map((candidate) => ({
      candidate,
      match: matchInvoiceToPo(invoiceLines, candidate.lines, invoiceTotal, candidate.total),
    }))
    .filter((row) => row.match.ok);

  if (hits.length === 1) return { status: "matched", candidate: hits[0]!.candidate, match: hits[0]!.match };
  if (hits.length > 1) return { status: "ambiguous", candidates: hits.map((row) => row.candidate) };
  return { status: "none" };
}

export function compareSoaToXero(
  soaInvoices: Array<{ invoiceNumber: string; amount: number }>,
  xeroBills: Array<{ invoiceNumber: string; amount: number; xeroBillId: string }>,
  paidXeroBills: Array<{ invoiceNumber: string; amount: number; xeroBillId: string }> = []
): SoaCompareResult {
  const normalizeNumber = (value: string) => value.trim().toLowerCase();
  const usedXero = new Set<string>();
  const matched: SoaCompareBucketItem[] = [];
  const missingFromXero: SoaCompareBucketItem[] = [];
  const alreadyPaid: SoaCompareBucketItem[] = [];
  const amountMismatch: SoaCompareResult["amountMismatch"] = [];

  for (const soa of soaInvoices) {
    const paid = paidXeroBills.find(
      (bill) => normalizeNumber(bill.invoiceNumber) === normalizeNumber(soa.invoiceNumber)
    );
    if (paid) {
      alreadyPaid.push({
        invoiceNumber: soa.invoiceNumber,
        amount: soa.amount,
        xeroBillId: paid.xeroBillId,
      });
      continue;
    }

    const xero = xeroBills.find(
      (bill) =>
        !usedXero.has(bill.xeroBillId) &&
        normalizeNumber(bill.invoiceNumber) === normalizeNumber(soa.invoiceNumber)
    );
    if (!xero) {
      missingFromXero.push({ invoiceNumber: soa.invoiceNumber, amount: soa.amount });
      continue;
    }
    usedXero.add(xero.xeroBillId);
    if (!totalsMatch(soa.amount, xero.amount)) {
      amountMismatch.push({
        invoiceNumber: soa.invoiceNumber,
        soaAmount: soa.amount,
        xeroAmount: xero.amount,
        xeroBillId: xero.xeroBillId,
      });
    } else {
      matched.push({
        invoiceNumber: soa.invoiceNumber,
        amount: soa.amount,
        xeroBillId: xero.xeroBillId,
      });
    }
  }

  const xeroAbsentFromSoa: SoaCompareBucketItem[] = xeroBills
    .filter((bill) => !usedXero.has(bill.xeroBillId))
    .map((bill) => ({
      invoiceNumber: bill.invoiceNumber,
      amount: bill.amount,
      xeroBillId: bill.xeroBillId,
    }));

  return { matched, missingFromXero, alreadyPaid, amountMismatch, xeroAbsentFromSoa };
}

export function parsePoModification(
  text: string,
  currentItems: ParsedOrderItem[]
): { items: ParsedOrderItem[]; summary: string } | null {
  const cleaned = text.replace(/@bot/gi, "").trim();
  const removeMatch = cleaned.match(/\b(?:remove|delete|drop)\s+(.+)$/i);
  if (removeMatch) {
    const needle = removeMatch[1]!.trim();
    const next = currentItems.filter((item) => !namesMatch(item.itemName, needle));
    if (next.length === currentItems.length) return null;
    return {
      items: next,
      summary: `Remove "${needle}"`,
    };
  }

  const changeMatch = cleaned.match(
    /\b(?:change|update|set)\s+(.+?)\s+(?:to\s+)?(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/i
  );
  if (changeMatch) {
    const needle = changeMatch[1]!.trim();
    const quantity = parseFloat(changeMatch[2]!);
    const unit = changeMatch[3];
    let found = false;
    const next = currentItems.map((item) => {
      if (!namesMatch(item.itemName, needle)) return item;
      found = true;
      return { ...item, quantity, unit: unit ?? item.unit };
    });
    if (!found) return null;
    return {
      items: next,
      summary: `Change "${needle}" to ${quantity}${unit ? ` ${unit}` : ""}`,
    };
  }

  const addMatch = cleaned.match(
    /\b(?:add|include)\s+(.+?)\s+(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/i
  );
  if (addMatch) {
    const itemName = addMatch[1]!.trim();
    const quantity = parseFloat(addMatch[2]!);
    return {
      items: [...currentItems, { itemName, quantity, unit: addMatch[3] }],
      summary: `Add ${itemName} ${quantity}${addMatch[3] ? ` ${addMatch[3]}` : ""}`,
    };
  }

  return null;
}

export type ReconcilePeriod = { start: Date; end: Date; label: string };

const MONTHS: Array<{ name: string; index: number }> = [
  { name: "january", index: 0 },
  { name: "february", index: 1 },
  { name: "march", index: 2 },
  { name: "april", index: 3 },
  { name: "may", index: 4 },
  { name: "june", index: 5 },
  { name: "july", index: 6 },
  { name: "august", index: 7 },
  { name: "september", index: 8 },
  { name: "october", index: 9 },
  { name: "november", index: 10 },
  { name: "december", index: 11 },
  { name: "jan", index: 0 },
  { name: "feb", index: 1 },
  { name: "mar", index: 2 },
  { name: "apr", index: 3 },
  { name: "jun", index: 5 },
  { name: "jul", index: 6 },
  { name: "aug", index: 7 },
  { name: "sept", index: 8 },
  { name: "sep", index: 8 },
  { name: "oct", index: 9 },
  { name: "nov", index: 10 },
  { name: "dec", index: 11 },
];

const MONTH_NAMES = MONTHS.map((month) => month.name).join("|");
const DATE_TOKEN =
  "\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{2,4}|\\d{1,2}\\s+[A-Za-z]{3,9}\\s+\\d{2,4}";

function monthsLongestFirst(): Array<{ name: string; index: number }> {
  return [...MONTHS].sort((a, b) => b.name.length - a.name.length);
}

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

function formatDay(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
}

function lookupMonth(name: string): number | null {
  const match = MONTHS.find((month) => month.name === name.toLowerCase());
  return match ? match.index : null;
}

export function getPreviousMonth(now = new Date()): ReconcilePeriod {
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  const label = start.toLocaleString("en-SG", { month: "long", year: "numeric" });
  return { start, end, label };
}

export function parseFlexibleDate(raw: string): Date | null {
  const value = raw.trim();
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]) - 1;
    const day = Number(iso[3]);
    const date = new Date(year, month, day);
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
    return startOfDay(date);
  }

  const named = value.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})$/);
  if (named) {
    const month = lookupMonth(named[2]!);
    if (month === null) return null;
    let year = named[3]!;
    if (year.length === 2) year = `20${year}`;
    const day = Number(named[1]);
    const date = new Date(Number(year), month, day);
    if (date.getFullYear() !== Number(year) || date.getMonth() !== month || date.getDate() !== day) {
      return null;
    }
    return startOfDay(date);
  }

  const slash = value.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!slash) return null;
  let year = slash[3]!;
  if (year.length === 2) year = `20${year}`;
  const day = Number(slash[1]);
  const month = Number(slash[2]) - 1;
  const date = new Date(Number(year), month, day);
  if (date.getFullYear() !== Number(year) || date.getMonth() !== month || date.getDate() !== day) {
    return null;
  }
  return startOfDay(date);
}

export function parsePeriodFromText(text: string, now = new Date()): ReconcilePeriod | null {
  const lower = text.toLowerCase();
  for (const entry of monthsLongestFirst()) {
    const match = lower.match(new RegExp(`\\b${entry.name}\\b(?:\\s+(\\d{4}))?`));
    if (!match) continue;
    const year = match[1] ? Number(match[1]) : now.getFullYear();
    const start = new Date(year, entry.index, 1);
    const end = new Date(year, entry.index + 1, 0, 23, 59, 59, 999);
    return {
      start,
      end,
      label: start.toLocaleString("en-SG", { month: "long", year: "numeric" }),
    };
  }
  return null;
}

export function parseReconcilePeriod(text: string, now = new Date()): ReconcilePeriod | null {
  const cleaned = text.replace(/@bot/gi, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  const monthPeriod = parsePeriodFromText(cleaned, now);
  if (monthPeriod) return monthPeriod;

  const range = cleaned.match(
    new RegExp(`(${DATE_TOKEN})\\s*(?:-|–|to|until|through)\\s*(${DATE_TOKEN})`, "i")
  );
  if (range) {
    const start = parseFlexibleDate(range[1]!);
    const end = parseFlexibleDate(range[2]!);
    if (start && end && end.getTime() >= start.getTime()) {
      return {
        start,
        end: endOfDay(end),
        label: `${formatDay(start)} - ${formatDay(end)}`,
      };
    }
  }

  const single = cleaned.match(new RegExp(`(?:^|\\s)(${DATE_TOKEN})(?:\\s|$)`, "i"));
  if (single) {
    const day = parseFlexibleDate(single[1]!);
    if (day) {
      return {
        start: day,
        end: endOfDay(day),
        label: formatDay(day),
      };
    }
  }

  if (
    /^(all|all time|everything|entire(?: history)?)$/i.test(cleaned) ||
    /\b(all time|entire history|everything)\b/i.test(cleaned) ||
    /\ball\s*$/i.test(cleaned)
  ) {
    return {
      start: new Date(2000, 0, 1),
      end: endOfDay(now),
      label: "All",
    };
  }

  return null;
}

export function stripReconcileKeywords(text: string): string {
  return text
    .replace(/@bot/gi, "")
    .replace(/\b(please|reconcile|payment|statement|for|check|soa)\b/gi, "")
    .trim();
}

export function extractReconcileSupplierName(text: string): string {
  return stripReconcileKeywords(text)
    .replace(new RegExp(`\\b(month|of|the|year)\\b`, "gi"), " ")
    .replace(new RegExp(`\\b(${MONTH_NAMES})\\b`, "gi"), " ")
    .replace(/\b(all(?:\s+time)?|everything|entire(?:\s+history)?)\b/gi, " ")
    .replace(/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b(20\d{2})\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchSupplierNameInText(text: string, supplierNames: string[]): string | null {
  const lower = text.toLowerCase();
  const mentioned = supplierNames
    .filter((name) => name.trim() && lower.includes(name.trim().toLowerCase()))
    .sort((a, b) => b.length - a.length);
  if (mentioned[0]) return mentioned[0];

  const needle = extractReconcileSupplierName(text).toLowerCase();
  if (!needle) return null;
  const partial = supplierNames
    .filter((name) => {
      const n = name.trim().toLowerCase();
      return n.includes(needle) || needle.includes(n);
    })
    .sort((a, b) => b.length - a.length);
  return partial[0] ?? null;
}
