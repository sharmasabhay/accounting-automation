# End-to-End Testing Guide

**Who this is for:** Supervisors and operations staff who want to walk through the full purchase-to-payment process and confirm everything works.

**What this system does:** It helps you go from “we need to order supplies” to “the supplier has been paid,” with less manual typing in WhatsApp, Xero, and DBS.

---

## The big picture (four steps)

```
1. Place order (PO)  →  2. Capture invoice  →  3. Reconcile statement  →  4. Pay supplier
```

| Step | Everyday meaning | What the system does |
|------|------------------|----------------------|
| **1. Purchase order** | You tell the bot what to order | Creates a purchase order and notifies the supplier |
| **2. Invoice** | Supplier sends an invoice (email or photo) | Reads the invoice and creates a bill in Xero |
| **3. Reconciliation** | You check what you still owe for the month | Builds a list of amounts ready to pay |
| **4. Payment** | You pay the supplier via DBS | Raises the payment in DBS (a human still approves it) |

---

## Before you start (one-time setup)

Ask your technical contact to confirm these are ready. You do **not** need to do this every test.

### Checklist

- [ ] The application is running (Admin page opens in the browser)
- [ ] The background worker is running (jobs are processed — without this, nothing finishes)
- [ ] You can sign in to **Admin** at: `http://127.0.0.1:3000/admin`
- [ ] You know your **sign-in token** (the password/token for Admin)
- [ ] Your organisation exists (e.g. “Omakase Demo”)
- [ ] At least one **supervisor** team member is added (with a WhatsApp phone number)
- [ ] At least one **supplier** is added (name, and ideally Xero contact + DBS payee name)
- [ ] **Xero** is connected under Integrations (optional for first practice runs)
- [ ] **WhatsApp** is configured if you want live messages (optional — Admin can simulate)

### Practice mode vs live mode

| Mode | What it means |
|------|----------------|
| **Practice (recommended first)** | The system logs what it *would* do in Xero/DBS, but does not move real money or create live accounting entries. Safe for learning. |
| **Live** | Real POs/bills in Xero and real payment requests in DBS. Only use after practice runs look correct. |

> **Tip:** For your first full walkthrough, stay in practice mode. Review the Activity tab and confirmations before going live.

---

## Part A — Sign in and open your organisation

1. Open the Admin page in your browser.
2. Enter your sign-in token when asked.
3. Click your organisation (for example **Omakase Demo**).
4. You will see tabs: **Overview**, **Team**, **Suppliers**, **Integrations**, **Activity**.

Keep the **Activity** tab handy — that is where you see recent workflows and run tests.

---

## Part B — Confirm suppliers are ready

Go to **Suppliers** and check each supplier you will use:

| Field | Why it matters |
|-------|----------------|
| **Name** | Must match how you refer to the supplier (and ideally match the name in Xero) |
| **Xero contact ID** | Links the supplier to the correct contact in Xero (or use an exact matching name in Xero) |
| **WhatsApp group ID** | Used when the bot posts the order into the supplier group |
| **DBS payee name** | Required before payment — must match a **saved payee already in DBS** (the system will not create new payees) |
| **Email domain** | Needed so invoices from that supplier’s email are accepted (e.g. `freshfarms.com.sg`) |

You can **Edit** or **Remove** suppliers from this screen.  
If Xero is connected, use **Load contacts from Xero** to copy the correct Contact ID.

---

## Part C — Step 1: Place a purchase order (PO)

### What success looks like

- The bot asks you to **confirm** the items and supplier first  
- Only after you reply **yes**, a purchase order is created  
- You get a confirmation (WhatsApp message and/or Activity log)  
- The supplier group gets an order message (if a group ID is set)  
- In practice mode, the log may say something like “dry run” instead of a real Xero PO  

### Option 1 — Test from Admin (easiest, no WhatsApp needed)

1. Open your organisation → **Activity**.
2. Under **Test WhatsApp webhook** (or **Test PO intake**):
   - Enter a simple order, for example:
     ```
     - Bok choy: 10 kg
     - Zucchini: 40 kg
     ```
3. Click **Test webhook** (or **Queue directly**).
4. Wait a few seconds — you should get a confirmation prompt listing the items.
5. Reply **yes** on WhatsApp (or via the pending approval flow) to create the PO.
6. Refresh the workflow list. Look for **PO_INTAKE** → **COMPLETED**.

> Random words, greetings, or “help” will **not** create a PO. The bot sends a short how-to guide instead.

### Option 2 — Test with a real WhatsApp message

1. From the **supervisor’s** WhatsApp number, send a direct message to the business WhatsApp number.
2. Use a clear list format, for example:
   ```
   - Bok choy: 10 kg
   - Zucchini: 40 kg
   ```
3. The bot replies with the parsed items and asks you to confirm.
4. Reply **yes** to create the PO (or **no** to cancel — nothing is written to Xero).
5. After confirmation you should receive something like:  
   `PO created: PO-2026-XXXX · Supplier: …`
6. If a supplier WhatsApp group is configured, the order should also appear there with a PO reference.

If you send something unclear (e.g. “hello”, “test”, a random word), the bot sends a **how-to guide** instead of creating a PO.

### If something goes wrong

| What you see | What to try |
|--------------|-------------|
| “Unauthorized” | The phone number is not set as a **Supervisor** under Team |
| “No supplier found” | Add an active supplier under Suppliers |
| “Could not parse your order” | Use a simple list with dashes and quantities |
| Workflow stays incomplete | Ask tech support to check that the **worker** is running |
| Xero error about contact | Set Xero Contact ID or create a matching supplier name in Xero |

### Checkpoint before Step 2

- [ ] Activity shows a completed PO workflow  
- [ ] You know which supplier the PO went to  
- [ ] (Optional) You can see the PO in Xero, if live mode is on  

---

## Part D — Step 2: Receive and capture the invoice

### What this step does

When an invoice arrives (email or WhatsApp photo), the system:

1. Reads supplier name, invoice number, date, lines, and total  
2. Checks it is not a duplicate  
3. Tries to match it to an open purchase order  
4. Creates a bill in Xero (or asks you to confirm if something is unclear)

### How invoices can arrive

| Channel | Who can use it | Status for testing |
|---------|----------------|--------------------|
| **WhatsApp** | Team members on the whitelist | **Use this now** — send an invoice image/PDF as a direct message |
| **Email** | Automatic daily scan of a dedicated inbox | Settings can be saved; full inbox reading is not finished yet |

> **For testing today:** use **WhatsApp upload** (Option 1 below). Email is the planned automatic path once IMAP scanning is fully connected.

> **Important — reading the invoice:** The system must have an **Anthropic API key** (`ANTHROPIC_API_KEY` in `.env`) so it can read the real supplier name from the photo. Without that key it uses practice sample data and will always think the supplier is **Fresh Farms Pte Ltd** for S$35 — which is wrong for real invoices like AbSupplier. Ask your technical contact to set the key and restart the worker.

---

### Option 1 — Receive invoice via WhatsApp (recommended now)

#### Before you send

1. Open **Admin → Team** and confirm the uploader is an active **team member** (their WhatsApp number must be on the list).
2. Open **Admin → Suppliers** and check the supplier **Name** looks like the name printed on the invoice (so the system can match it).
3. Make sure a **purchase order** already exists for that supplier (complete Part C first). Matching an open PO is the cleanest path.

#### How to send the invoice

1. From that team member’s phone, open WhatsApp.
2. Send a **direct message** (not a group message) to the business WhatsApp number.
3. Attach a clear **photo** or **PDF** of the invoice.
4. Send it. Do not send text-only — text messages are treated as purchase-order requests, not invoices.

#### What happens next

Watch for a WhatsApp reply, then check **Admin → Activity** for an **INVOICE_CAPTURE** workflow.

| Reply you may see | Meaning | What you should do |
|-------------------|---------|-------------------|
| `Bill created: …` | Success — bill linked to a PO | Note it and continue to reconciliation when ready |
| Question about unclear fields | The system is unsure about supplier, invoice number, or total | Check the invoice and reply to confirm |
| `doesn't match any open PO. Create new PO?` | No suitable open PO found | Reply **yes** or **no** |
| `Duplicate invoice skipped` | That invoice number was already processed | No action needed (unless it was a mistake) |
| `Unauthorized upload` | That phone is not on the team list | Add them under **Team**, then resend |
| `No attachment found` | Message had no image/PDF | Resend with the file attached |

#### Requirements checklist (WhatsApp)

| Need | Why |
|------|-----|
| Sender is a **team member** | Only whitelisted phones can upload invoices |
| Message is an **image** or **document** | Text-only messages go to PO intake, not invoice capture |
| Supplier **Name** roughly matches the invoice | Used to find the right supplier |
| Open **PO** exists (ideal) | Clean match → bill created; otherwise the bot asks you |

---

### Option 2 — Receive invoice via email (planned / automatic)

#### Intended setup (for when email scanning is live)

1. Create a dedicated inbox (for example `invoices@yourcompany.com`).
2. In **Admin → Integrations → Email**, enter IMAP host, user, and app password; save.
3. On each supplier, set **Email domain** (for example `freshfarms.com.sg`) so only those senders are accepted.
4. Ask the supplier to email invoices (with PDF/image attachments) to that inbox.
5. The system is meant to scan daily (around **8:00 AM SGT**), read attachments, and process them the same way as WhatsApp uploads.
6. You (or the supervisor) may get WhatsApp questions if something is unclear.

#### Current status

Email settings can be saved in Admin, but the inbox scan is **not fully reading mail yet**. Until your technical contact confirms email scanning is live, **use WhatsApp upload** for receiving invoices.

---

### Suggested order for an invoice test

1. Place a **PO** first (Part C — Activity → Test webhook, or a WhatsApp order).  
2. Send a matching **invoice photo/PDF** via WhatsApp from a team member.  
3. Answer any bot questions (**yes** / **no**, or the detail asked).  
4. Confirm **INVOICE_CAPTURE** completed in **Admin → Activity**.  

### Important approvals you may see

| Question from the bot | Your role |
|-----------------------|-----------|
| Confirm unclear fields | Check the invoice and confirm or correct |
| Amounts / quantities don’t match the PO | Decide how to resolve before a bill is created |
| No matching PO — create one from the invoice? | Reply **yes** or **no** |

### If nothing happens

| Symptom | What to check |
|---------|----------------|
| No workflow appears | Worker is running; WhatsApp is connected; message was a photo/PDF DM |
| Unauthorized | Phone is listed under **Team** for that organisation |
| No matching PO | Create a PO first, or approve “create PO from invoice” |
| Wrong supplier | Supplier **Name** in Admin should resemble the name on the invoice |

### Checkpoint before Step 3

- [ ] Invoice was sent as a WhatsApp photo/PDF from a team member  
- [ ] Invoice was accepted (or you knowingly held it / answered a question)  
- [ ] **INVOICE_CAPTURE** shows in Activity  
- [ ] A bill exists for that supplier (in practice mode, this may be simulated)  
- [ ] You were notified on WhatsApp if confirmation was needed  

---

## Part E — Step 3: Reconcile and prepare payment

### What this step does

Usually once a month (or when you ask), the system checks what is still owed for a supplier for a period (by default, **last calendar month**), compares with a statement of account (SOA) if available, and builds a **payable list** ready for payment.

### How to start reconciliation

**From WhatsApp (supervisor DM)** — send something like:

```
Please reconcile payment for Fresh Farms
```

Include the **supplier name** so the system knows who to check.

**From a supplier WhatsApp group** — a team member can @tag the bot with a reconcile / statement request (group must be linked to that supplier).

### What you may be asked

| Situation | What the bot may ask |
|-----------|----------------------|
| No statement of account found | Reconcile from Xero only, or request SOA from the supplier? |
| Figures don’t match | Help resolve the mismatch |
| Prior month balance still open | Clarify what to include |
| Late invoice | Confirm the goods were received |

### Checkpoint before Step 4

- [ ] Reconciliation finished for the supplier and period you care about  
- [ ] The payable total looks correct  
- [ ] Supplier has a **DBS payee name** set in Admin  

---

## Part F — Step 4: Pay the supplier (DBS)

### Critical safety rule

**The bot can raise a payment request in DBS. It cannot move money by itself.**

A separate human **approver** in DBS must approve the payment. That is the final control.

Also:

- Payments only go to **existing saved payees** in DBS  
- The bot will **not** add new bank payees  

### Typical payment flow

1. After reconciliation, payment preparation starts.
2. The bot asks you to stand by with the DBS app (reply **ready** when you are ready).
3. You complete any DBS login / slide-to-approve steps on your phone as prompted by your bank.
4. The payment is raised in DBS for the approver.
5. The DBS approver (a different person) approves the payment in DBS.
6. Once approved, bills can be marked paid in Xero (in practice mode this is simulated).

### What success looks like

- You received a standby / ready prompt and replied  
- DBS shows a payment awaiting approval (live mode) **or** the log shows a simulated payment (practice mode)  
- After approval, you get a confirmation that payment was recorded  
- Activity shows a **PAYMENT_EXECUTION** workflow completing  

### If payment stops early

| Message / situation | Likely cause |
|---------------------|--------------|
| “No saved DBS payee…” | Add the exact DBS payee name on the supplier in Admin |
| Nothing happens after reconcile | Worker not running, or payable list was empty |
| Stuck waiting for “ready” | Reply **ready** from the supervisor WhatsApp |

---

## Suggested full practice run (same day)

Use this as a single checklist from start to finish.

### Morning — Order

1. [ ] Sign in to Admin  
2. [ ] Confirm supplier details (Xero + DBS payee)  
3. [ ] Place a PO via **Activity → Test webhook** with 1–2 line items  
4. [ ] Confirm the bot asked you to approve the items, then reply **yes**  
5. [ ] Confirm **PO_INTAKE** is **COMPLETED**  

### Midday — Invoice

6. [ ] Send a matching invoice **photo or PDF** via WhatsApp from a **team member** (direct message to the bot)  
7. [ ] Answer any clarification questions on WhatsApp  
8. [ ] Confirm **INVOICE_CAPTURE** completed and a bill is linked to the PO  
9. [ ] (Later) When email scanning is live, also test supplier email to the invoice inbox  

### Afternoon — Reconcile & pay

10. [ ] Message: “Please reconcile payment for [Supplier Name]”  
11. [ ] Review the payable summary  
12. [ ] When asked, reply **ready** for DBS standby  
13. [ ] In practice mode: confirm logs show a simulated DBS payment  
14. [ ] In live mode: confirm DBS payment is awaiting the human approver, then approve  

### End of day — Review

15. [ ] Open **Activity** and scan all workflows for the day  
16. [ ] Note anything unclear for the technical contact  
17. [ ] Do **not** turn on live money movement until practice runs look clean  

---

## How to check results without technical tools

| Place | What to look for |
|-------|------------------|
| **Admin → Activity** | Recent workflows: PO_INTAKE, INVOICE_CAPTURE, RECONCILIATION, PAYMENT_EXECUTION and their status |
| **WhatsApp (supervisor)** | Confirmations, questions, and payment prompts |
| **Xero** (live mode) | Purchase orders, bills, paid status |
| **DBS IDEAL** (live mode) | Payment awaiting approval / completed |
| **Supplier WhatsApp group** | Order messages with PO reference |

Statuses you will see often:

| Status | Meaning |
|--------|---------|
| **COMPLETED** | That step finished successfully |
| **IN_PROGRESS** | Still running, or waiting on something |
| **AWAITING_APPROVAL** | The bot is waiting for your WhatsApp reply |
| **FAILED** | Something went wrong — share the time and workflow with tech support |

---

## Roles at a glance

| Role | What they do in this process |
|------|------------------------------|
| **Supervisor** | Places orders, answers bot questions, stands by for DBS login |
| **Team member** | May upload invoices; may @tag the bot in groups |
| **DBS approver** | Approves the actual payment in the bank (must be a different person) |
| **Supplier** | Receives orders, sends invoices / statements |
| **Technical contact** | Keeps the app, WhatsApp, Xero, and DBS connections running |

---

## Common questions

**Do I need WhatsApp for every test?**  
No. For purchase orders, use **Activity → Test WhatsApp webhook** in Admin. Live WhatsApp is needed to practice real messages, **invoice uploads**, and approvals.

**How do I receive an invoice for testing?**  
Send a clear invoice **photo or PDF** as a WhatsApp **direct message** from a team member’s phone. Email inbox scanning is not fully live yet — see **Part D**.

**Will this pay suppliers by itself?**  
No. A human must approve in DBS. The bot only prepares / raises the payment.

**What if I make a mistake on the order?**  
In a supplier group, modifications that @tag the bot still need supervisor approval before the PO is changed.

**What is “practice mode”?**  
The system pretends to write to Xero and DBS and writes safe log messages instead. Use this until you trust the flow.

**Who do I call if Activity shows FAILED?**  
Your technical contact. Share: organisation name, approximate time, and which step (PO / invoice / reconcile / pay).

---

## Quick reference — message examples

**Place an order (WhatsApp DM to the bot):**
```
- Bok choy: 10 kg
- Zucchini: 40 kg
```

**Start reconciliation (supervisor DM):**
```
Please reconcile payment for Fresh Farms
```

**Approve / continue when asked:**
```
yes
```
or
```
ready
```

---

## After a successful practice run

When the full loop looks correct in practice mode:

1. Confirm Xero is connected and supplier contacts match  
2. Confirm DBS credentials and saved payees are correct  
3. Agree with your team who the DBS approver is  
4. Ask the technical contact to switch from practice mode to live mode  
5. Run **one small real transaction** end-to-end and review it carefully before normal daily use  

---

*Document version: aligned with Phase 1 procure-to-pay (purchase order → invoice → reconciliation → DBS payment). Some invoice, email, and DBS steps may still use practice/simulation depending on your environment — your technical contact can confirm what is live.*
