1. Purchase request → PO supplier order. The supervisor DMs the bot on WhatsApp with something like "Bok choy 10kg, zucchini 40kg." The bot parses the items, matches them to Xero SKUs, infers the normal supplier if one isn't specified, and looks up the most recent price paid to that supplier. If SKU, supplier, or price is uncertain, it
asks the supervisor rather than guessing. phase1_requirements (1)
Once everything is resolved, it generates a PO reference, sends the formatted order into that supplier's WhatsApp group, and immediately creates the PO in Xero. There is no waiting for supplier confirmation before PO creation. phase1_requirements (1)
After that, if someone in the supplier group says something like "@bot remove salmon" or makes another change, the bot understands the proposed modification but does not change the Xero PO automatically. It privately asks the supervisor for approval first. Only after approval does it edit the PO; if the original PO can no longer be edited, it voids and recreates it.
phase1_requirements (1)

2. Supplier invoice arrives → validate against PO→ create Xero bill. Invoices enter through either the dedicated invoice email inbox or an authorized team member uploading one through WhatsApp. Email attachments are processed individually,
because one email may contain several invoices. phase1 requirements (1)
The first protection is a duplicate check using supplier + invoice number against existing Xero bills. Then OCR extracts supplier, invoice number/date, item descriptions, quantities and unit amounts. Claude vision is used as fallback where OCR is uncertain, and a human is asked only if both are still uncertain. The system also checks whether a signature or company chop is present, but absence of one only creates a warning;
it does not reject the invoice.
phase1_requirements (1)
The invoice is then matched to an open PO for the same supplier within 10 days before the invoice date. Supplier terminology is translated into your internal SKU terminology using a persistent supplier-SKU mapping table. If a new mapping has to be learned, the supervisor confirms it once and the bot remembers that mapping for subsequent invoices. Quantity must match exactly and the monetary total has a +S$0.10 tolerance.
phase1_requirements (1)
If everything matches, the PO is converted automatically into a Xero bill and the original invoice file is attached. If quantity, amount, or line items disagree, processing stops for supervisor resolution. If there is no matching PO at all, the bot asks whether it should create a PO retrospectively from the invoice; only after approval does it create that PO and continue to the bill.
phase1_requirements (1)

3. Month-end / payment request - SOA reconciliation payable list. Reconciliation can be initiated by the supervisor, by someone tagging the bot in a supplier WhatsApp group, or when a supplier posts/sends an SOA. If no period is specified, the
default is the previous calendar month. phase1 requirements (1)
The bot searches both email and the supplier WhatsApp group for the relevant SOA. It identifies SOAs using subject/filename terms plus document layout. If no SOA exists, it asks the supervisor whether to reconcile using Xero only or request an SOA from the supplier. Separately, when a new SOA arrives during normal email scanning, it
proactively tells the supervisor and asks whether to reconcile it.
phase1_requirements (1)
It extracts the SOA invoice numbers, amounts and balance due, then compares those against Xero. Each invoice effectively falls into one of three important buckets: matched, missing from Xero, or amount mismatch. Xero bills that are absent from the supplier SOA are also flagged because that may indicate either a supplier omission or
a billing-cycle timing difference.
phase1 requirements (1)
There is also special handling for older unpaid balances. The bot doesn't assume those should automatically be paid: it asks whether to pay the full outstanding balance, current month only, or a custom amount.
phase1 requirements (1)
One particularly important sub-flow is when the SOA contains an invoice that Xero doesn't have. The bot asks the supplier in WhatsApp for that exact invoice. When it arrives, it extracts and validates it, but this time it does not immediately create a bill. It first asks the supervisor to confirm that the goods/order were actually received.
Only then is the bill created and added to the payable list.
phase1_requirements (1)
At the end, the supervisor gets a reconciliation summary showing SOA totals, Xero totals, matched invoices, mismatches, missing invoices and the final payable list. That payable list automatically flows into DBS payment preparation. ☑ phase1_requirements (1)

4. Payable list - DBS payment raised human approval - Xero paid. The bot receives a supplier-level batch containing the supplier, amount, reference and associated Xero bill IDs. It first checks that the supplier already exists as a saved DBS payee and that the office machine/DBS session is available. The bot is expressly not allowed to create
new payees. phase1_requirements (1)
Before logging in, the bot WhatsApps the supervisor saying it is ready and asks the supervisor to stand by with the DBS mobile app. Only when the supervisor replies "ready" does it enter DBS credentials, which triggers the DBS mobile login approval.
The supervisor slides to approve the login.
phase1 requirements (1)
Importantly, after logging in it first checks DBS transaction history to make sure a previous crashed/incomplete run didn't already create the payment. That is the anti-
duplicate protection on the banking side. phase1_requirements (1)
The bot then selects the saved payee, inputs the total, uses "Business Expenses", enters the month or invoice references, reviews the screen and submits the payment. It captures the DBS transaction reference. Multiple suppliers can be processed during
the same active DBS session.
phase1 requirements (1)
Once the payment has merely been raised, the related bills in Xero are marked Awaiting Payment, not Paid. The bot periodically checks DBS to see whether the independent DBS approver has approved the transaction. Only once that approval is detected does it mark the bills Paid in Xero and notify the supervisor.
9 phase1 requirements (1)