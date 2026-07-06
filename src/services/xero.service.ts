import { config } from "../config/index.js";
import { prisma } from "../db/client.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/storage.js";
import { integrationConfigService } from "./integration-config.service.js";
import type { XeroIntegrationConfig } from "../types/integrations.js";

const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface XeroPurchaseOrderInput {
  supplierContactId: string;
  contactName?: string;
  lineItems: Array<{
    itemCode?: string;
    description: string;
    quantity: number;
    unitAmount: number;
  }>;
}

export interface XeroBillInput {
  purchaseOrderId?: string;
  supplierContactId: string;
  invoiceNumber: string;
  invoiceDate: string;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitAmount: number;
  }>;
  total: number;
}

interface XeroTokenRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tenantId: string;
}

interface XeroPurchaseOrderResponse {
  PurchaseOrders?: Array<{
    PurchaseOrderID?: string;
    PurchaseOrderNumber?: string;
  }>;
}

interface XeroContactsResponse {
  Contacts?: Array<{
    ContactID?: string;
    Name?: string;
    EmailAddress?: string;
  }>;
}

class XeroService {
  private async getOrgConfig(organizationId: string): Promise<XeroIntegrationConfig> {
    return integrationConfigService.getXero(organizationId);
  }

  async getAuthUrl(organizationId: string, organizationSlug: string): Promise<string> {
    const xero = await this.getOrgConfig(organizationId);
    if (!xero.clientId || !xero.redirectUri) {
      throw new Error("Xero client ID and redirect URI must be configured for this organization");
    }

    const state = Buffer.from(JSON.stringify({ organizationId, organizationSlug })).toString(
      "base64url"
    );

    const scopes = [
      "openid",
      "profile",
      "email",
      "offline_access",
      "accounting.contacts",
      "accounting.attachments",
      "accounting.invoices",
      "accounting.payments",
    ];

    const params = new URLSearchParams({
      response_type: "code",
      client_id: xero.clientId,
      redirect_uri: xero.redirectUri,
      scope: scopes.join(" "),
      state,
    });
    return `https://login.xero.com/identity/connect/authorize?${params}`;
  }

  async handleOAuthCallback(code: string, organizationId: string): Promise<void> {
    const xero = await this.getOrgConfig(organizationId);
    if (!xero.clientId || !xero.clientSecret || !xero.redirectUri) {
      throw new Error("Xero OAuth not configured for this organization");
    }

    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${xero.clientId}:${xero.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: xero.redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      throw new Error(`Xero token exchange failed: ${body}`);
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const connectionsRes = await fetch("https://api.xero.com/connections", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const connections = (await connectionsRes.json()) as Array<{ tenantId: string }>;
    const tenantId = connections[0]?.tenantId ?? xero.tenantId ?? "";

    await this.saveTokens(organizationId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      tenantId,
    });

    const { organizationService } = await import("./organization.service.js");
    const { IntegrationType } = await import("@prisma/client");
    const existing = await organizationService.getIntegration(organizationId, IntegrationType.XERO);
    const existingConfig = (existing?.config ?? {}) as Record<string, unknown>;

    await organizationService.setIntegration(organizationId, IntegrationType.XERO, {
      ...existingConfig,
      tenantId,
      connected: true,
      connectedAt: new Date().toISOString(),
    });
  }

  async getConnectionStatus(organizationId: string): Promise<{ connected: boolean; tenantId?: string }> {
    const token = await prisma.xeroToken.findUnique({ where: { organizationId } });
    const xero = await this.getOrgConfig(organizationId);
    return {
      connected: Boolean(token && xero.connected),
      tenantId: token?.tenantId ?? xero.tenantId,
    };
  }

  async listContacts(
    organizationId: string
  ): Promise<Array<{ contactId: string; name: string; email?: string }>> {
    if (config.DRY_RUN || !(await this.isConfiguredForOrg(organizationId))) {
      return [];
    }

    const result = await this.xeroApiRequest<XeroContactsResponse>(
      organizationId,
      "GET",
      '/Contacts?where=IsSupplier==true&order=Name'
    );

    return (result.Contacts ?? [])
      .filter((c) => c.ContactID && c.Name)
      .map((c) => ({
        contactId: c.ContactID!,
        name: c.Name!,
        email: (c as { EmailAddress?: string }).EmailAddress,
      }));
  }

  private async isConfiguredForOrg(organizationId: string): Promise<boolean> {
    const xero = await this.getOrgConfig(organizationId);
    const token = await prisma.xeroToken.findUnique({ where: { organizationId } });
    return integrationConfigService.isXeroConfigured(xero) && Boolean(token);
  }

  private async saveTokens(organizationId: string, tokens: XeroTokenRecord): Promise<void> {
    await prisma.xeroToken.upsert({
      where: { organizationId },
      create: { organizationId, ...tokens },
      update: tokens,
    });
  }

  private async getValidToken(organizationId: string): Promise<XeroTokenRecord> {
    const stored = await prisma.xeroToken.findUnique({ where: { organizationId } });
    if (!stored) {
      throw new Error("Xero not connected for this organization — use Admin → Connect Xero");
    }

    const expiresSoon = stored.expiresAt.getTime() - Date.now() < 60_000;
    if (!expiresSoon) {
      return stored;
    }

    return this.refreshAccessToken(organizationId, stored.refreshToken);
  }

  private async refreshAccessToken(
    organizationId: string,
    refreshToken: string
  ): Promise<XeroTokenRecord> {
    const xero = await this.getOrgConfig(organizationId);
    if (!xero.clientId || !xero.clientSecret) {
      throw new Error("Xero client credentials missing");
    }

    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${xero.clientId}:${xero.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      throw new Error(`Xero token refresh failed: ${body}`);
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const record: XeroTokenRecord = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      tenantId: (await prisma.xeroToken.findUnique({ where: { organizationId } }))!.tenantId,
    };

    await this.saveTokens(organizationId, record);
    logger.info({ organizationId }, "Xero access token refreshed");
    return record;
  }

  private async xeroApiRequest<T>(
    organizationId: string,
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const token = await this.getValidToken(organizationId);

    const response = await fetch(`${XERO_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "xero-tenant-id": token.tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    if (!response.ok) {
      logger.error({ organizationId, path, status: response.status, body: text }, "Xero API error");
      throw new Error(`Xero API ${response.status}: ${text}`);
    }

    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  private isXeroUuid(value: string): boolean {
    return UUID_RE.test(value);
  }

  private async resolveContactId(
    organizationId: string,
    contactIdOrFallback: string,
    contactName?: string
  ): Promise<string> {
    if (this.isXeroUuid(contactIdOrFallback)) {
      return contactIdOrFallback;
    }

    if (!contactName) {
      throw new Error(
        "Supplier has no Xero Contact ID — set xeroContactId in Admin → Suppliers (UUID from Xero)"
      );
    }

    const escaped = contactName.replace(/"/g, '\\"');
    const result = await this.xeroApiRequest<XeroContactsResponse>(
      organizationId,
      "GET",
      `/Contacts?where=Name=="${escaped}"`
    );

    const contact = result.Contacts?.[0];
    if (!contact?.ContactID) {
      throw new Error(
        `No Xero contact found for supplier "${contactName}". Create the supplier in Xero or set xeroContactId.`
      );
    }

    logger.info(
      { organizationId, contactName, contactId: contact.ContactID },
      "Resolved Xero contact by name"
    );
    return contact.ContactID;
  }

  async createPurchaseOrder(
    organizationId: string,
    input: XeroPurchaseOrderInput
  ): Promise<{ xeroPoId: string; xeroPoNumber: string }> {
    if (config.DRY_RUN || !(await this.isConfiguredForOrg(organizationId))) {
      const mockId = `DRY-PO-${Date.now()}`;
      logger.info({ organizationId, input, mockId }, "[DRY_RUN] Xero PO created");
      return { xeroPoId: mockId, xeroPoNumber: mockId };
    }

    return withRetry(async () => {
      const contactId = await this.resolveContactId(
        organizationId,
        input.supplierContactId,
        input.contactName
      );

      const payload = {
        PurchaseOrders: [
          {
            Contact: { ContactID: contactId },
            LineItems: input.lineItems.map((line) => ({
              Description: line.description,
              Quantity: line.quantity,
              UnitAmount: line.unitAmount,
              ...(line.itemCode ? { ItemCode: line.itemCode } : {}),
            })),
            Status: "AUTHORISED",
          },
        ],
      };

      const result = await this.xeroApiRequest<XeroPurchaseOrderResponse>(
        organizationId,
        "POST",
        "/PurchaseOrders",
        payload
      );

      const po = result.PurchaseOrders?.[0];
      if (!po?.PurchaseOrderID) {
        throw new Error("Xero did not return a Purchase Order ID");
      }

      logger.info(
        {
          organizationId,
          xeroPoId: po.PurchaseOrderID,
          xeroPoNumber: po.PurchaseOrderNumber,
        },
        "Xero PO created"
      );

      return {
        xeroPoId: po.PurchaseOrderID,
        xeroPoNumber: po.PurchaseOrderNumber ?? po.PurchaseOrderID,
      };
    });
  }

  async convertPoToBill(
    organizationId: string,
    input: XeroBillInput
  ): Promise<{ xeroBillId: string }> {
    if (config.DRY_RUN || !(await this.isConfiguredForOrg(organizationId))) {
      const mockId = `DRY-BILL-${Date.now()}`;
      logger.info({ organizationId, input, mockId }, "[DRY_RUN] Xero bill created");
      return { xeroBillId: mockId };
    }

    return withRetry(async () => {
      throw new Error("Xero bill creation from PO not yet implemented");
    });
  }

  async findDuplicateBill(
    organizationId: string,
    supplierContactId: string,
    invoiceNumber: string
  ): Promise<boolean> {
    const existing = await prisma.xeroBill.findFirst({
      where: {
        invoiceNumber,
        supplier: { organizationId, xeroContactId: supplierContactId },
      },
    });
    return Boolean(existing);
  }

  async updateBillStatus(
    organizationId: string,
    xeroBillId: string,
    status: "AWAITING_PAYMENT" | "PAID",
    note?: string
  ): Promise<void> {
    if (config.DRY_RUN || !(await this.isConfiguredForOrg(organizationId))) {
      logger.info({ organizationId, xeroBillId, status, note }, "[DRY_RUN] Xero bill status updated");
      return;
    }

    await withRetry(async () => {
      throw new Error("Xero bill status update not yet implemented");
    });
  }

  async getOpenPurchaseOrders(_organizationId: string, _supplierContactId: string, _beforeDate: Date) {
    return [];
  }

  async getBillsForPeriod(_organizationId: string, _supplierContactId: string, _start: Date, _end: Date) {
    return [];
  }
}

export const xeroService = new XeroService();
