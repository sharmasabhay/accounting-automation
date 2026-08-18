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
2. WhatsApp `phone_number_id` or WABA `entry.id` → org integration config
3. Sender phone → team member lookup
4. Group ID → supplier lookup

## Testing Workflows (without WhatsApp)

Legacy global endpoints (`/api/workflows`) still work but are deprecated — use org-scoped routes or the admin UI.

## Admin UI & Per-Organization Integrations

### How integrations work

Each organization stores integration credentials in `OrganizationIntegration` (type + JSON config). At runtime, services load **per-org config first**, then fall back to global `.env` values.

| Integration | Config keys | How it's used |
|---|---|---|
| **Xero** | `clientId`, `clientSecret`, `redirectUri`, `tenantId` | Admin → Save → **Connect Xero** (OAuth). Tokens stored in `XeroToken` per org. |
| **WhatsApp** | `apiToken`, `phoneNumberId`, `verifyToken`, `businessAccountId` | Outbound messages use org token. Inbound webhook resolves org via `phoneNumberId` / WABA id. Prefer **Generate onboarding link** (Embedded Signup) over pasting tokens. |
| **Email IMAP** | `imapHost`, `imapPort`, `imapUser`, `imapPassword`, folders | Daily email scan uses org's dedicated invoice inbox. |
| **DBS** | `idealUrl`, `orgId`, `userId`, `password`, `headless` | Playwright macro uses org's DBS IDEAL credentials for payments. |
| **OCR** | `provider`, Google/AWS keys | Invoice extraction per org (optional). |

### Xero OAuth flow (per organization)

1. Admin UI → Organization → **Integrations** → fill Client ID, Client Secret, Redirect URI
2. Redirect URI must be: `http://127.0.0.1:3000/auth/xero/callback` (add to Xero app)
3. Click **Connect Xero** → authorize in Xero → redirected back
4. `tenantId` and OAuth tokens saved for that organization only

### WhatsApp setup (per organization)

**Option A — Embedded Signup (recommended for multi-tenant)**

1. Configure the partner Meta app in `.env` (`META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_ID`, `PUBLIC_BASE_URL`)
2. Admin UI → Organization → **Integrations** → WhatsApp → **Generate onboarding link**
3. Send the link to the tenant. They authorize your app on their WhatsApp Business Account
4. Credentials (`apiToken`, `phoneNumberId`, `businessAccountId`) are saved automatically
5. Webhooks arrive at the global endpoint and are routed to the tenant by `phone_number_id` / WABA id

**Option B — Manual credentials**

1. Create a Meta WhatsApp Business app (or use the shared partner app)
2. Admin UI → Integrations → WhatsApp → enter `apiToken` and `phoneNumberId`
3. Register webhook: `https://<your-tunnel>/webhooks/whatsapp` (global endpoint; org resolved by `phone_number_id`)

### Tenant WhatsApp onboarding (Embedded Signup)

Omakase acts as a **Tech Provider / partner**. Tenants authorize the partner Meta app on *their* WhatsApp Business Account via Facebook Embedded Signup — no need to share API tokens by hand.

1. In [Meta Developer Console](https://developers.facebook.com/) create (or open) your WhatsApp Business app and complete Tech Provider / Embedded Signup setup.
2. Create a **Facebook Login for Business** configuration and note the **Configuration ID**.
3. Set in `.env`:

```env
META_APP_ID=your-app-id
META_APP_SECRET=your-app-secret
META_CONFIG_ID=your-embedded-signup-config-id
PUBLIC_BASE_URL=https://your-public-tunnel.example
WHATSAPP_VERIFY_TOKEN=change-me-webhook-verify-token
```

4. Point the Meta app webhook to `https://<PUBLIC_BASE_URL>/webhooks/whatsapp` and subscribe to `messages`.
5. From Admin → Integrations → WhatsApp, click **Generate onboarding link** and send it to the tenant.
6. The tenant opens `/onboarding/whatsapp/<token>`, signs in with Facebook, picks their WABA + phone number, and authorizes the app.
7. The backend exchanges the signup code, subscribes the app to the tenant's WABA, registers the phone number, and stores the tenant's WhatsApp integration.

Webhook verification uses `WHATSAPP_VERIFY_TOKEN`. Incoming POSTs are signature-checked with `META_APP_SECRET` (`X-Hub-Signature-256`) when the secret is set.

Tenant resolution for inbound messages (highest priority first):

1. Explicit `organizationId` (API tests)
2. `phone_number_id` or WABA `entry.id` → org WhatsApp integration
3. Sender phone → team member
4. Group ID → supplier

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

1. Create a Meta WhatsApp Business app (partner / Tech Provider) and obtain API credentials.
2. Set in `.env`:
   - `META_APP_ID` / `META_APP_SECRET` / `META_CONFIG_ID` (Embedded Signup)
   - `WHATSAPP_VERIFY_TOKEN` (webhook handshake)
   - `PUBLIC_BASE_URL` (public HTTPS URL of this server)
   - Optional fallbacks: `WHATSAPP_API_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`
3. Expose the local server via a tunnel (e.g. Cloudflare Tunnel, ngrok):

   ```bash
   ngrok http 3000
   ```

4. Configure Meta webhook URL: `https://<your-tunnel>/webhooks/whatsapp`
5. Subscribe to `messages` events.
6. Onboard each tenant via Admin → Integrations → WhatsApp → **Generate onboarding link**.

## Project Structure

```
src/
│   ├── routes/           # Org admin + Xero/WhatsApp onboarding OAuth
│   └── webhooks/         # WhatsApp Cloud API webhook
├── config/               # Environment validation (Zod)
├── db/                   # Prisma client
├── jobs/                 # BullMQ queue, worker, schedulers
├── orchestrator/         # Event router → workflows
├── workflows/            # Sub-process 1–4 implementations
├── services/             # Xero, WhatsApp, OCR, LLM, DBS, audit, auth
├── prompts/              # LLM system prompts (injection-safe)
└── types/                # Shared TypeScript interfaces

public/
├── admin/                # Platform admin UI
└── onboarding/           # Tenant-facing WhatsApp Embedded Signup page

prisma/
└── schema.prisma         # Database schema

storage/
├── invoices/             # Raw invoice attachments
└── audit-logs/           # Append-only audit files (7-year retention)
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
| `WHATSAPP_API_TOKEN` | No | Meta WhatsApp API fallback (prefer per-org Embedded Signup) |
| `META_APP_ID` | No* | Partner Meta app ID (*required for Embedded Signup) |
| `META_APP_SECRET` | No* | Partner Meta app secret (also used for webhook signature checks) |
| `META_CONFIG_ID` | No* | Facebook Login for Business Embedded Signup configuration ID |
| `PUBLIC_BASE_URL` | No | Public HTTPS base URL used in tenant onboarding links |
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
