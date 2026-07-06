# Omakase Accounting — Phase 1

Node.js application for automating the procure-to-pay loop: purchase orders, invoice capture, reconciliation, and DBS payment execution.

## Prerequisites

- **Node.js** 20+ (22 LTS recommended)
- **Docker** and **Docker Compose** (for PostgreSQL and Redis)
- **npm** 10+

## Quick Start

### 1. Clone and install dependencies

```bash
cd /var/www/html/omakase_accounting
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```env
API_TOKEN=your-secure-random-token
DATABASE_URL=postgresql://omakase:omakase_secret@localhost:5432/omakase_accounting?schema=public
REDIS_URL=redis://localhost:6379
DRY_RUN=true
SUPERVISOR_PHONE=+6590000000
```

`DRY_RUN=true` is recommended for development — Xero and DBS writes are simulated and logged instead of executed.

### 3. Start infrastructure (PostgreSQL + Redis)

```bash
docker-compose up -d
```

Wait until both services are healthy:

```bash
docker-compose ps
```

### 4. Initialize the database

```bash
npm run db:generate
npm run db:push
npm run db:seed
```

### 5. Run the application

You need **two terminals** — the API server and the background worker.

**Terminal 1 — API server:**

```bash
npm run dev
```

**Terminal 2 — Job worker (queues, schedulers, workflow processing):**

```bash
npm run worker
```

The API listens on `http://127.0.0.1:3000` (localhost only).

### 6. Verify it is running

```bash
curl http://127.0.0.1:3000/health
```

Expected response:

```json
{"status":"ok","dryRun":true,"timestamp":"..."}
```

### 7. Open the Admin UI

```
http://127.0.0.1:3000/admin
```

Sign in with your `API_TOKEN` from `.env`. From the admin UI you can:

- Onboard and manage organizations
- Add team members and suppliers
- Configure per-org integrations (Xero, WhatsApp, Email IMAP, DBS)
- Connect Xero via OAuth
- Run test workflows

### Test PO intake via API (org-scoped)

```bash
# List organizations
curl -H "Authorization: Bearer your-secure-random-token" \
  http://127.0.0.1:3000/api/organizations

# Test PO intake for a specific organization
curl -X POST http://127.0.0.1:3000/api/organizations/omakase-demo/test/po-intake \
  -H "Authorization: Bearer your-secure-random-token" \
  -H "Content-Type: application/json" \
  -d '{"message": "- Bok choy: 10 kg\n- Zucchini: 40 kg"}'
```

Make sure the **worker** is running — it processes the queued job.

### View org-scoped workflows and audit logs

```bash
curl -H "Authorization: Bearer your-secure-random-token" \
  http://127.0.0.1:3000/api/organizations/omakase-demo/workflows

curl -H "Authorization: Bearer your-secure-random-token" \
  http://127.0.0.1:3000/api/organizations/omakase-demo/audit
```

## Multi-Tenant Product Model

Each **organization** (company) is an isolated tenant with its own:

- Team members and supervisors (WhatsApp phone whitelist)
- Suppliers, POs, bills, reconciliations
- Per-org integrations (Xero, WhatsApp, Email, DBS credentials)
- Audit logs and file storage (`storage/invoices/{orgId}/`)

### Onboard a new organization

```bash
curl -X POST http://127.0.0.1:3000/api/organizations \
  -H "Authorization: Bearer your-secure-random-token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Company Pte Ltd",
    "slug": "my-company",
    "timezone": "Asia/Singapore",
    "supervisor": { "name": "Jane", "phoneNumber": "+6591234567" }
  }'
```

### Add suppliers and integrations

```bash
# Add supplier
curl -X POST http://127.0.0.1:3000/api/organizations/my-company/suppliers \
  -H "Authorization: Bearer your-secure-random-token" \
  -H "Content-Type: application/json" \
  -d '{"name": "Fresh Farms", "emailDomain": "freshfarms.com.sg", "dbsPayeeName": "FRESH FARMS PTE LTD"}'

# Configure WhatsApp integration (maps Meta phone_number_id to this org)
curl -X PUT http://127.0.0.1:3000/api/organizations/my-company/integrations/WHATSAPP \
  -H "Authorization: Bearer your-secure-random-token" \
  -H "Content-Type: application/json" \
  -d '{"phoneNumberId": "YOUR_META_PHONE_NUMBER_ID", "apiToken": "YOUR_TOKEN"}'
```

### Tenant resolution (incoming WhatsApp)

When a message arrives, the system resolves the organization by:

1. Explicit `organizationId` (API test calls)
2. Sender phone → team member lookup
3. Group ID → supplier lookup
4. WhatsApp `phone_number_id` → org integration config

## Testing Workflows (without WhatsApp)

Legacy global endpoints (`/api/workflows`) still work but are deprecated — use org-scoped routes or the admin UI.

## Admin UI & Per-Organization Integrations

### How integrations work

Each organization stores integration credentials in `OrganizationIntegration` (type + JSON config). At runtime, services load **per-org config first**, then fall back to global `.env` values.

| Integration | Config keys | How it's used |
|---|---|---|
| **Xero** | `clientId`, `clientSecret`, `redirectUri`, `tenantId` | Admin → Save → **Connect Xero** (OAuth). Tokens stored in `XeroToken` per org. |
| **WhatsApp** | `apiToken`, `phoneNumberId`, `verifyToken` | Outbound messages use org token. Inbound webhook resolves org via `phoneNumberId`. |
| **Email IMAP** | `imapHost`, `imapPort`, `imapUser`, `imapPassword`, folders | Daily email scan uses org's dedicated invoice inbox. |
| **DBS** | `idealUrl`, `orgId`, `userId`, `password`, `headless` | Playwright macro uses org's DBS IDEAL credentials for payments. |
| **OCR** | `provider`, Google/AWS keys | Invoice extraction per org (optional). |

### Xero OAuth flow (per organization)

1. Admin UI → Organization → **Integrations** → fill Client ID, Client Secret, Redirect URI
2. Redirect URI must be: `http://127.0.0.1:3000/auth/xero/callback` (add to Xero app)
3. Click **Connect Xero** → authorize in Xero → redirected back
4. `tenantId` and OAuth tokens saved for that organization only

### WhatsApp setup (per organization)

1. Create a Meta WhatsApp Business app
2. Admin UI → Integrations → WhatsApp → enter `apiToken` and `phoneNumberId`
3. Register webhook: `https://<your-tunnel>/webhooks/whatsapp` (global endpoint; org resolved by `phone_number_id`)

### Email IMAP setup (per organization)

1. Create a dedicated invoice inbox (e.g. `invoices@mycompany.com`)
2. Admin UI → Integrations → Email → enter IMAP host, user, app password
3. Daily scan job runs per organization using those credentials

### DBS setup (per organization)

1. Admin UI → Integrations → DBS → enter Organisation ID, User ID
2. Password stored in org config (local DB; encrypt at rest in production)
3. Playwright automation runs on the office desktop using org-specific credentials

## Production Build

```bash
npm run build
npm start          # API server (dist/index.js)
npm run worker     # Worker (uses tsx in dev; build worker separately for prod)
```

For production process management with PM2:

```bash
npm run build
pm2 start ecosystem.config.cjs
```

## WhatsApp Webhook Setup

1. Create a Meta WhatsApp Business app and obtain API credentials.
2. Set in `.env`:
   - `WHATSAPP_API_TOKEN`
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_VERIFY_TOKEN`
3. Expose the local server via a tunnel (e.g. Cloudflare Tunnel, ngrok):

   ```bash
   ngrok http 3000
   ```

4. Configure Meta webhook URL: `https://<your-tunnel>/webhooks/whatsapp`
5. Subscribe to `messages` events.

## Project Structure

```
src/
├── api/              # Fastify server, webhooks, admin endpoints
├── config/           # Environment validation (Zod)
├── db/               # Prisma client
├── jobs/             # BullMQ queue, worker, schedulers
├── orchestrator/     # Event router → workflows
├── workflows/        # Sub-process 1–4 implementations
├── services/         # Xero, WhatsApp, OCR, LLM, DBS, audit, auth
├── prompts/          # LLM system prompts (injection-safe)
└── types/            # Shared TypeScript interfaces

prisma/
└── schema.prisma     # Database schema

storage/
├── invoices/         # Raw invoice attachments
└── audit-logs/       # Append-only audit files (7-year retention)
```

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `API_TOKEN` | Yes | Bearer token for protected API routes |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | Redis for BullMQ job queue |
| `DRY_RUN` | No | `true` = simulate Xero/DBS writes (default: `true`) |
| `ANTHROPIC_API_KEY` | No | Claude API for parsing/extraction (falls back to mock) |
| `XERO_CLIENT_ID` | No | Xero OAuth (required for live Xero integration) |
| `WHATSAPP_API_TOKEN` | No | Meta WhatsApp API (logs messages in dry mode) |
| `EMAIL_IMAP_*` | No | Invoice inbox scanning |
| `DBS_*` | No | DBS IDEAL Playwright automation |

See `.env.example` for the full list.

## Scheduled Jobs

| Job | Schedule | Description |
|---|---|---|
| `email.scan` | Daily 8:00 AM SGT | Scan invoice inbox |
| `payment.monitor` | Every 4 hours | Check DBS payment approvals |

Schedulers are registered when the worker starts.

## Security Notes

- API binds to `127.0.0.1` only — do not expose publicly without a reverse proxy and auth.
- All webhook/admin routes require `Authorization: Bearer <API_TOKEN>` except `/health` and WhatsApp verification.
- Storage directories are created with `chmod 700`; audit logs with `chmod 600`.
- Run with `DRY_RUN=true` for the first month of operation per requirements.

## Troubleshooting

| Issue | Fix |
|---|---|
| `Invalid environment configuration` | Copy `.env.example` to `.env` and set `API_TOKEN` |
| `Can't reach database` | Run `docker-compose up -d` and wait for healthy status |
| Jobs not processing | Ensure `npm run worker` is running in a separate terminal |
| Redis connection refused | Check `docker-compose ps` — Redis must be running |
| Prisma client not found | Run `npm run db:generate` |

## Next Steps

1. Connect Xero OAuth and replace dry-run stubs in `src/services/xero.service.ts`
2. Configure WhatsApp Business API credentials
3. Wire IMAP email scanning in `src/services/email.service.ts`
4. Implement DBS Playwright macro using `playwright/dbs/selectors.json` (run `npx playwright install` first)
5. Evaluate OCR providers (Google Document AI vs AWS Textract)
