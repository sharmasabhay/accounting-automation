import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseInvoiceText } from "./invoice-parse.js";

describe("parseInvoiceText", () => {
  it("parses the ABSupplier sample invoice", () => {
    const text = `
                           ABSupplier
INVOICE
Invoice Number: INV-0001

     Item                         Qty    Amount
     Blueberries                  2 Kg   100
     Total                               100
`;
    const result = parseInvoiceText(text);
    assert.equal(result.supplier.value, "ABSupplier");
    assert.equal(result.invoiceNumber.value, "INV-0001");
    assert.equal(result.total.value, 100);
    assert.equal(result.lineItems.length, 1);
    assert.equal(result.lineItems[0]?.name.value, "Blueberries");
    assert.equal(result.lineItems[0]?.quantity.value, 2);
    assert.equal(result.lineItems[0]?.unitAmount.value, 50);
  });

  it("treats the last number as unit price when that matches the total", () => {
    const text = `
Fresh Farms Pte Ltd
Invoice No: INV-2026-0044
Date: 20/09/2026
Bok choy 10 kg 3.50
Total S$35.00
`;
    const result = parseInvoiceText(text);
    assert.equal(result.supplier.value, "Fresh Farms Pte Ltd");
    assert.equal(result.invoiceNumber.value, "INV-2026-0044");
    assert.equal(result.invoiceDate.value, "2026-09-20");
    assert.equal(result.total.value, 35);
    assert.equal(result.lineItems[0]?.quantity.value, 10);
    assert.equal(result.lineItems[0]?.unitAmount.value, 3.5);
  });

  it("matches GST table invoice and uses PO number when invoice number is blank", () => {
    const text = `
                         SUPPLIER INVOICE                                                         INVOICE
     Supplier                                 Bill To                                   Invoice Details

     AbSupplier                               Test Omakase                              Invoice No.:
                                                                                        __________________

     Address:                                 Address:                                  Invoice Date: 20 Sep 2026
     GST Reg. No.:                            GST Reg. No.:                             PO No.: PO-2026-6823

 #     Description                                   Qty           Unit Price (SGD)     GST           Amount (SGD)

 1     Cucumber                                             2.00                15.00            9%                    30.00

 2     Beetroot                                             1.00                15.00            9%                    15.00

Subtotal                                                                                                         SGD 45.00
TOTAL                                                                                                            SGD 49.05
                                                                                               Amount Due: SGD 49.05
`;
    const result = parseInvoiceText(text, "Invoice_PO-2026-6823.pdf");
    assert.equal(result.supplier.value, "AbSupplier");
    assert.equal(result.invoiceNumber.value, "PO-2026-6823");
    assert.equal(result.poNumber?.value, "PO-2026-6823");
    assert.equal(result.invoiceDate.value, "2026-09-20");
    assert.equal(result.total.value, 49.05);
    assert.equal(result.lineItems.length, 2);
    assert.equal(result.lineItems[0]?.name.value, "Cucumber");
    assert.equal(result.lineItems[0]?.quantity.value, 2);
    assert.equal(result.lineItems[0]?.unitAmount.value, 15);
    assert.equal(result.lineItems[1]?.name.value, "Beetroot");
    assert.equal(result.lineItems[1]?.quantity.value, 1);
    assert.equal(result.lineItems[1]?.unitAmount.value, 15);
  });

  it("parses unnumbered GST rows from a purchase-order style invoice", () => {
    const text = `
PURCHASE ORDER
                              Purchase Order Date        Test Omakase
                              20 Sep 2026
      AbSupplier
                              Purchase Order Number
                              PO-2026-2874

Description        Quantity         Unit Price          Tax     Amount SGD

beetroot              2.00              15.00           9%              30.00

lady finger           5.00                3.50          9%              17.50

                                                    Subtotal            47.50
                                                 TOTAL SGD              51.78
`;
    const result = parseInvoiceText(text, "Purchase_Order_PO20262874.pdf");
    assert.equal(result.supplier.value, "AbSupplier");
    assert.equal(result.poNumber?.value, "PO-2026-2874");
    assert.equal(result.total.value, 51.78);
    assert.equal(result.lineItems.length, 2);
    assert.equal(result.lineItems[0]?.name.value, "beetroot");
    assert.equal(result.lineItems[0]?.quantity.value, 2);
    assert.equal(result.lineItems[0]?.unitAmount.value, 15);
    assert.equal(result.lineItems[1]?.name.value, "lady finger");
    assert.equal(result.lineItems[1]?.quantity.value, 5);
    assert.equal(result.lineItems[1]?.unitAmount.value, 3.5);
  });

  it("parses unnumbered invoice rows with a numeric tax column", () => {
    const text = `
AbSupplier
TAX INVOICE
Invoice Number         INV-2026-4939
Invoice Date           20 Sep 2026
Purchase Order No.     PO-2026-4939

 DESCRIPTION                                               QTY          UNIT PRICE         TAX           AMOUNT (SGD)
 Cucumber                                                 5.00                  15.00     0.00                    75.00
                                                    TOTAL SGD                                                    75.00
`;
    const result = parseInvoiceText(text, "Invoice_INV-2026-4939.pdf");
    assert.equal(result.supplier.value, "AbSupplier");
    assert.equal(result.invoiceNumber.value, "INV-2026-4939");
    assert.equal(result.poNumber?.value, "PO-2026-4939");
    assert.equal(result.lineItems.length, 1);
    assert.equal(result.lineItems[0]?.name.value, "Cucumber");
    assert.equal(result.lineItems[0]?.quantity.value, 5);
    assert.equal(result.lineItems[0]?.unitAmount.value, 15);
    assert.equal(result.total.value, 75);
  });
});
