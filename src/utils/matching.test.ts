import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseColonPurchaseOrder,
  parseFreeformPurchaseOrder,
  parsePurchaseOrderLocal,
  matchInvoiceToPo,
  selectInvoicePurchaseOrder,
  isWithinDaysBefore,
  compareSoaToXero,
  parsePoModification,
  isSoaDocument,
  namesMatch,
  catalogItemMatches,
  extractReconcileSupplierName,
  matchSupplierNameInText,
  parsePeriodFromText,
  parseReconcilePeriod,
  isRestartCommand,
  looksLikeNewPurchaseOrder,
  looksLikeSupplierChange,
  isAffirmativeReply,
  isNegativeReply,
  isReadyReply,
  normalizeChatReply,
  parsePoItemDetailsReply,
  suggestedItemCode,
} from "./matching.js";

describe("PO parse", () => {
  it("parses colon format", () => {
    const result = parseColonPurchaseOrder("- Bok choy: 10 kg\n- Zucchini: 40 kg");
    assert.equal(result.isPurchaseOrder, true);
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0]?.itemName, "Bok choy");
    assert.equal(result.items[0]?.quantity, 10);
  });

  it("parses freeform Bok choy 10kg, zucchini 40kg", () => {
    const result = parseFreeformPurchaseOrder("Bok choy 10kg, zucchini 40kg");
    assert.equal(result.isPurchaseOrder, true);
    assert.equal(result.items.length, 2);
    assert.equal(result.items[1]?.itemName.toLowerCase(), "zucchini");
    assert.equal(result.items[1]?.quantity, 40);
  });

  it("rejects help text", () => {
    const result = parsePurchaseOrderLocal("help");
    assert.equal(result.isPurchaseOrder, false);
  });

  it("treats a restated order as a new PO, not an approval answer", () => {
    assert.equal(looksLikeNewPurchaseOrder("Apple 10kg, banana 5kg"), true);
    assert.equal(looksLikeNewPurchaseOrder("Bok choy 2kg, Pepper 5kg"), true);
    assert.equal(looksLikeNewPurchaseOrder("3.50"), false);
    assert.equal(looksLikeNewPurchaseOrder("yes"), false);
    assert.equal(looksLikeNewPurchaseOrder("Lady finger: 3.50\nRed pepper: 4"), false);
    assert.equal(isRestartCommand("restart"), true);
    assert.equal(looksLikeSupplierChange("change supplier"), true);
    assert.equal(looksLikeSupplierChange("*change supplier*"), true);
    assert.equal(isRestartCommand("*restart*"), true);
    assert.equal(isAffirmativeReply("yes"), true);
    assert.equal(isAffirmativeReply("*yes*"), true);
    assert.equal(isAffirmativeReply("YES"), true);
    assert.equal(isAffirmativeReply("yes!"), true);
    assert.equal(isNegativeReply("*no*"), true);
    assert.equal(isReadyReply("*ready*"), true);
    assert.equal(normalizeChatReply("*yes*"), "yes");
  });
});

describe("PO item details reply", () => {
  it("parses one price per new item", () => {
    const result = parsePoItemDetailsReply(
      "Bok choy: 3.50\nZucchini: 4",
      ["Bok choy", "Zucchini"]
    );
    assert.equal(result.length, 2);
    assert.equal(result[0]?.unitPrice, 3.5);
    assert.equal(result[1]?.itemName, "Zucchini");
  });

  it("parses item code plus price", () => {
    const result = parsePoItemDetailsReply("Bok choy: BOKCHOY 5", ["Bok choy"]);
    assert.equal(result[0]?.code, "BOKCHOY");
    assert.equal(result[0]?.unitPrice, 5);
  });

  it("assigns numbered lines in order", () => {
    const result = parsePoItemDetailsReply("3.50\n4.00", ["Bok choy", "Zucchini"]);
    assert.equal(result[0]?.unitPrice, 3.5);
    assert.equal(result[1]?.unitPrice, 4);
  });

  it("builds a compact Xero item code from the name", () => {
    assert.equal(suggestedItemCode("Bok choy"), "BOKCHOY");
  });
});

describe("invoice vs PO matching", () => {
  const po = [{ name: "Bok Choy", quantity: 10, unitAmount: 3.5 }];

  it("matches exact quantity and total", () => {
    const result = matchInvoiceToPo(
      [{ name: "bok choy", quantity: 10, unitAmount: 3.5 }],
      po,
      35,
      35
    );
    assert.equal(result.ok, true);
  });

  it("fails on quantity mismatch", () => {
    const result = matchInvoiceToPo(
      [{ name: "bok choy", quantity: 9, unitAmount: 3.5 }],
      po,
      31.5,
      35
    );
    assert.equal(result.ok, false);
    assert.equal(result.quantityMismatch, true);
  });

  it("allows GST-inclusive invoice total when line subtotal matches the PO", () => {
    const result = matchInvoiceToPo(
      [
        { name: "Cucumber", quantity: 2, unitAmount: 15 },
        { name: "Beetroot", quantity: 1, unitAmount: 15 },
      ],
      [
        { name: "Cucumber", quantity: 2, unitAmount: 15 },
        { name: "Beetroot", quantity: 1, unitAmount: 15 },
      ],
      49.05,
      45
    );
    assert.equal(result.ok, true);
    assert.equal(result.amountMismatch, false);
  });

  it("allows 9% GST on the invoice total against the PO subtotal", () => {
    const result = matchInvoiceToPo(
      [
        { name: "beetroot", quantity: 2, unitAmount: 15 },
        { name: "lady finger", quantity: 5, unitAmount: 3.5 },
      ],
      [
        { name: "beetroot", quantity: 2, unitAmount: 15 },
        { name: "lady finger", quantity: 5, unitAmount: 3.5 },
      ],
      51.78,
      47.5
    );
    assert.equal(result.ok, true);
    assert.equal(result.amountMismatch, false);
  });

  it("enforces 10-day PO window", () => {
    const invoice = new Date("2026-06-15");
    assert.equal(isWithinDaysBefore(new Date("2026-06-05"), invoice), true);
    assert.equal(isWithinDaysBefore(new Date("2026-06-04"), invoice), false);
    assert.equal(isWithinDaysBefore(new Date("2026-06-16"), invoice), false);
  });
});

describe("select invoice purchase order", () => {
  const older = {
    localId: "old",
    poNumber: "PO-2026-6823",
    lines: [
      { name: "Cucumber", quantity: 2, unitAmount: 15 },
      { name: "Beetroot", quantity: 1, unitAmount: 15 },
    ],
    total: 45,
  };
  const latest = {
    localId: "new",
    poNumber: "PO-2026-4939",
    lines: [{ name: "Cucumber", quantity: 5, unitAmount: 15 }],
    total: 75,
  };
  const invoiceLines = [
    { name: "Cucumber", quantity: 2, unitAmount: 15 },
    { name: "Beetroot", quantity: 1, unitAmount: 15 },
  ];

  it("uses the PO number printed on the invoice, not the latest PO", () => {
    const result = selectInvoicePurchaseOrder(invoiceLines, 49.05, [latest, older], "PO-2026-6823");
    assert.equal(result.status, "matched");
    if (result.status === "matched") assert.equal(result.candidate.poNumber, "PO-2026-6823");
  });

  it("falls back to unique line-item match when no PO number is printed", () => {
    const result = selectInvoicePurchaseOrder(invoiceLines, 49.05, [latest, older]);
    assert.equal(result.status, "matched");
    if (result.status === "matched") assert.equal(result.candidate.poNumber, "PO-2026-6823");
  });

  it("asks when two open POs both match the invoice lines", () => {
    const twin = { ...older, localId: "twin", poNumber: "PO-2026-7000" };
    const result = selectInvoicePurchaseOrder(invoiceLines, 49.05, [older, twin]);
    assert.equal(result.status, "ambiguous");
    if (result.status === "ambiguous") assert.equal(result.candidates.length, 2);
  });

  it("reports a named mismatch against the cited PO, not a different one", () => {
    const result = selectInvoicePurchaseOrder(
      [{ name: "Cucumber", quantity: 5, unitAmount: 15 }],
      75,
      [latest, older],
      "PO-2026-6823"
    );
    assert.equal(result.status, "named-mismatch");
    if (result.status === "named-mismatch") assert.equal(result.candidate.poNumber, "PO-2026-6823");
  });
});

describe("SKU name matching", () => {
  it("matches similar names", () => {
    assert.equal(namesMatch("Bok Choy", "bok choy"), true);
  });

  it("matches unmapped chat names to Xero catalog names", () => {
    assert.equal(catalogItemMatches("Bok choy", "Bok Choy"), true);
    assert.equal(catalogItemMatches("zucchini", "Organic Zucchini"), true);
    assert.equal(catalogItemMatches("Bok choy 10kg", "Bok-Choy"), true);
    assert.equal(catalogItemMatches("zucchini", "ZUCC", "ZUCC"), true);
  });
});

describe("SOA compare", () => {
  it("buckets matched, missing, mismatch, and xero-only", () => {
    const result = compareSoaToXero(
      [
        { invoiceNumber: "INV-1", amount: 10 },
        { invoiceNumber: "INV-2", amount: 20 },
        { invoiceNumber: "INV-3", amount: 30 },
      ],
      [
        { invoiceNumber: "INV-1", amount: 10, xeroBillId: "a" },
        { invoiceNumber: "INV-2", amount: 21, xeroBillId: "b" },
        { invoiceNumber: "INV-9", amount: 5, xeroBillId: "c" },
      ]
    );
    assert.equal(result.matched.length, 1);
    assert.equal(result.amountMismatch.length, 1);
    assert.equal(result.missingFromXero[0]?.invoiceNumber, "INV-3");
    assert.equal(result.xeroAbsentFromSoa[0]?.invoiceNumber, "INV-9");
    assert.equal(result.alreadyPaid.length, 0);
  });

  it("skips SOA invoices that are already paid in Xero", () => {
    const result = compareSoaToXero(
      [
        { invoiceNumber: "INV-PAID", amount: 50 },
        { invoiceNumber: "INV-OPEN", amount: 20 },
      ],
      [{ invoiceNumber: "INV-OPEN", amount: 20, xeroBillId: "open" }],
      [{ invoiceNumber: "INV-PAID", amount: 50, xeroBillId: "paid" }]
    );
    assert.equal(result.alreadyPaid[0]?.invoiceNumber, "INV-PAID");
    assert.equal(result.matched[0]?.invoiceNumber, "INV-OPEN");
    assert.equal(result.missingFromXero.length, 0);
  });
});

describe("PO modification parse", () => {
  const items = [
    { itemName: "Salmon", quantity: 2, unit: "kg" },
    { itemName: "Zucchini", quantity: 40, unit: "kg" },
  ];

  it("removes an item", () => {
    const result = parsePoModification("@bot remove salmon", items);
    assert.ok(result);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.itemName, "Zucchini");
  });
});

describe("SOA document detection", () => {
  it("detects SOA filenames and subjects", () => {
    assert.equal(isSoaDocument("SOA-June.pdf", "Statement"), true);
    assert.equal(isSoaDocument("invoice-1.pdf", "Invoice"), false);
  });
});

describe("reconcile supplier + period parse", () => {
  const now = new Date("2026-09-20T12:00:00");

  it("keeps AbSupplier when a month is included", () => {
    const text = "Please reconcile payment for AbSupplier month September 2026";
    assert.equal(extractReconcileSupplierName(text), "AbSupplier");
    assert.equal(
      matchSupplierNameInText(text, ["ABCompany", "AbSupplier", "AbSuppliers"]),
      "AbSupplier"
    );
    const period = parsePeriodFromText(text, now);
    assert.equal(period?.label, "September 2026");
  });

  it("prefers the longer supplier name when both match", () => {
    assert.equal(
      matchSupplierNameInText("reconcile AbSuppliers", ["AbSupplier", "AbSuppliers"]),
      "AbSuppliers"
    );
  });

  it("does not infer a period from a supplier-only reconcile request", () => {
    assert.equal(parseReconcilePeriod("Please reconcile payment for AbSupplier", now), null);
  });

  it("parses month, date range, and all replies", () => {
    assert.equal(parseReconcilePeriod("September 2026", now)?.label, "September 2026");
    assert.equal(parseReconcilePeriod("Sep 2026", now)?.label, "September 2026");
    assert.equal(
      parseReconcilePeriod("01/09/2026 - 30/09/2026", now)?.label,
      "01/09/2026 - 30/09/2026"
    );
    assert.equal(parseReconcilePeriod("all", now)?.label, "All");
    assert.equal(parseReconcilePeriod("Please reconcile payment for AbSupplier all", now)?.label, "All");
    assert.equal(extractReconcileSupplierName("Please reconcile payment for AbSupplier all"), "AbSupplier");
  });
});
