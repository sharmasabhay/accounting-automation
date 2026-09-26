import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db/client.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/storage.js";
import { isWithinDaysBefore, namesMatch, suggestedItemCode, isPlausibleItemCode } from "../utils/matching.js";
import { XeroApiError, notifySupervisorOfXeroError } from "../utils/xero-error.js";
import { integrationConfigService } from "./integration-config.service.js";
import type { XeroIntegrationConfig } from "../types/integrations.js";
import type { XeroBillRecord, XeroItem, XeroOpenPurchaseOrder } from "../types/index.js";

const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface XeroPurchaseOrderInput {
  supplierContactId: string;
  contactName?: string;
  purchaseOrderNumber?: string;
  lineItems: Array<{
    itemCode?: string;
    description: string;
    quantity: number;
    unitAmount: number;
  }>;
}

export interface XeroBillInput {
  purchaseOrderId?: string;
  purchaseOrderNumber?: string;
  supplierContactId: string;
  contactName?: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate?: string;
  lineItems: Array<{
    itemCode?: string;
    description: string;
    quantity: number;
    unitAmount: number;
  }>;
  total: number;
  attachmentPath?: string;
  attachmentName?: string;
}

interface XeroTokenRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tenantId: string;
}

interface XeroPurchaseOrderRecord {
  PurchaseOrderID?: string;
  PurchaseOrderNumber?: string;
  Status?: string;
  Date?: string;
  DateString?: string;
  Total?: number;
  HasErrors?: boolean;
  ValidationErrors?: Array<{ Message?: string }>;
  LineItems?: Array<{
    Description?: string;
    ItemCode?: string;
    Quantity?: number;
    UnitAmount?: number;
    LineAmount?: number;
  }>;
}

interface XeroPurchaseOrderResponse {
  PurchaseOrders?: XeroPurchaseOrderRecord[];
  Elements?: Array<{
    ValidationErrors?: Array<{ Message?: string }>;
  }>;
}

interface XeroContactRecord {
  ContactID?: string;
  Name?: string;
  EmailAddress?: string;
  IsSupplier?: boolean;
  ContactStatus?: string;
}

interface XeroContactsResponse {
  Contacts?: XeroContactRecord[];
}

interface XeroItemsResponse {
  Items?: Array<{
    ItemID?: string;
    Code?: string;
    Name?: string;
    PurchaseDetails?: { UnitPrice?: number };
    SalesDetails?: { UnitPrice?: number };
  }>;
}

interface XeroInvoicesResponse {
  Invoices?: Array<{
    InvoiceID?: string;
    InvoiceNumber?: string;
    Date?: string;
    DateString?: string;
    Total?: number;
    Status?: string;
    AmountDue?: number;
    HasErrors?: boolean;
    ValidationErrors?: Array<{ Message?: string }>;
  }>;
}

interface XeroAccountsResponse {
  Accounts?: Array<{
    AccountID?: string;
    Code?: string;
    Name?: string;
    Type?: string;
    Status?: string;
    Class?: string;
  }>;
}

class XeroService {
  private accountCache = new Map<string, { bankAccountId?: string; expenseCode?: string }>();
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
      "accounting.items",
      "accounting.settings",
      "accounting.settings.read"
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
    if (!(await this.isConfiguredForOrg(organizationId))) {
      return [];
    }

    const result = await this.xeroApiRequest<XeroContactsResponse>(
      organizationId,
      "GET",
      "/Contacts"
    );

    return (result.Contacts ?? [])
      .filter((c) => c.ContactID && c.Name)
      .map((c) => ({
        contactId: c.ContactID!,
        name: c.Name!,
        email: c.EmailAddress,
      }));
  }

  async ensureSupplierContact(
    organizationId: string,
    input: { name: string; email?: string }
  ): Promise<{ contactId: string; name: string; created: boolean }> {
    const name = input.name.trim();
    if (!name) {
      throw new XeroApiError("Supplier name is required to create a Xero contact");
    }
    if (!(await this.isConfiguredForOrg(organizationId))) {
      throw new XeroApiError(
        "Xero is not connected for this organisation. Connect Xero in Admin → Integrations, then add the supplier."
      );
    }

    const existing = await this.findContactByName(organizationId, name);
    if (existing?.ContactID) {
      if (existing.IsSupplier === false || existing.ContactStatus === "ARCHIVED") {
        await this.xeroApiRequest<XeroContactsResponse>(organizationId, "POST", "/Contacts", {
          Contacts: [
            {
              ContactID: existing.ContactID,
              IsSupplier: true,
              ...(existing.ContactStatus === "ARCHIVED" ? { ContactStatus: "ACTIVE" } : {}),
            },
          ],
        });
      }
      logger.info(
        { organizationId, name, contactId: existing.ContactID },
        "Reusing existing Xero supplier contact"
      );
      return { contactId: existing.ContactID, name: existing.Name ?? name, created: false };
    }

    try {
      const result = await this.xeroApiRequest<XeroContactsResponse>(organizationId, "POST", "/Contacts", {
        Contacts: [
          {
            Name: name,
            IsSupplier: true,
            ...(input.email ? { EmailAddress: input.email } : {}),
          },
        ],
      });
      const created = result.Contacts?.[0];
      if (!created?.ContactID) {
        throw new XeroApiError("Xero did not return a contact ID after creating the supplier");
      }
      logger.info(
        { organizationId, name, contactId: created.ContactID },
        "Created Xero supplier contact"
      );
      return { contactId: created.ContactID, name: created.Name ?? name, created: true };
    } catch (error) {
      const retry = await this.findContactByName(organizationId, name);
      if (retry?.ContactID) {
        return { contactId: retry.ContactID, name: retry.Name ?? name, created: false };
      }
      throw error;
    }
  }

  private async findContactByName(
    organizationId: string,
    name: string
  ): Promise<XeroContactRecord | undefined> {
    const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const where = encodeURIComponent(`Name=="${escaped}"`);
    const result = await this.xeroApiRequest<XeroContactsResponse>(
      organizationId,
      "GET",
      `/Contacts?where=${where}`
    );
    return (
      result.Contacts?.find(
        (contact) => contact.ContactID && contact.Name?.toLowerCase() === name.toLowerCase()
      ) ?? result.Contacts?.find((contact) => Boolean(contact.ContactID))
    );
  }

  async listItems(organizationId: string): Promise<XeroItem[]> {
    if (!(await this.isConfiguredForOrg(organizationId))) {
      logger.info({ organizationId }, "Xero not connected — items list skipped");
      return [];
    }

    const items: XeroItem[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = await this.xeroApiRequest<XeroItemsResponse>(
        organizationId,
        "GET",
        `/Items?page=${page}`
      );
      const batch = result.Items ?? [];
      for (const item of batch) {
        if (!item.ItemID || !item.Name) continue;
        const purchasePrice = item.PurchaseDetails?.UnitPrice ?? item.SalesDetails?.UnitPrice;
        items.push({
          itemId: item.ItemID,
          code: item.Code ?? item.ItemID,
          name: item.Name,
          purchaseUnitPrice:
            purchasePrice != null && Number(purchasePrice) > 0 ? Number(purchasePrice) : undefined,
        });
      }
      if (batch.length < 100) break;
    }
    return items;
  }

  async ensurePurchaseItem(
    organizationId: string,
    input: { name: string; code?: string; unitPrice?: number }
  ): Promise<XeroItem> {
    const name = input.name.trim();
    if (!name) {
      throw new XeroApiError("Item name is required to create a Xero item");
    }

    const catalog = await this.listItems(organizationId);
    const requested = input.code?.trim();
    if (requested) {
      const byCode = catalog.find(
        (item) => item.code.toLowerCase() === requested.toLowerCase()
      );
      if (byCode) return byCode;
    }
    const byName = catalog.filter((item) => namesMatch(item.name, name));
    if (byName.length === 1) return byName[0]!;

    const baseCode = suggestedItemCode(requested || name);
    let code = baseCode;
    let suffix = 2;
    const taken = new Set(catalog.map((item) => item.code.toUpperCase()));
    while (taken.has(code.toUpperCase()) && suffix < 100) {
      code = `${baseCode.slice(0, 28)}${suffix}`;
      suffix += 1;
    }

    if (!(await this.isConfiguredForOrg(organizationId))) {
      logger.info({ organizationId, name, code }, "Xero not connected — mock item created");
      return { itemId: `DRY-ITEM-${code}`, code, name, purchaseUnitPrice: input.unitPrice };
    }

    const accountCode = await this.resolveExpenseAccountCode(organizationId);
    try {
      const result = await this.xeroApiRequest<XeroItemsResponse>(organizationId, "POST", "/Items", {
        Items: [
          {
            Code: code,
            Name: name.slice(0, 50),
            Description: name,
            IsPurchased: true,
            PurchaseDetails: {
              UnitPrice: input.unitPrice ?? 0,
              AccountCode: accountCode,
            },
          },
        ],
      });
      const created = result.Items?.[0];
      if (!created?.ItemID) {
        throw new XeroApiError("Xero did not return an item ID after creating the catalog item");
      }
      logger.info(
        { organizationId, name, code: created.Code ?? code, itemId: created.ItemID },
        "Created Xero purchase item"
      );
      return {
        itemId: created.ItemID,
        code: created.Code ?? code,
        name: created.Name ?? name,
        purchaseUnitPrice: input.unitPrice,
      };
    } catch (error) {
      const retry = (await this.listItems(organizationId)).find(
        (item) =>
          item.code.toUpperCase() === code.toUpperCase() || namesMatch(item.name, name)
      );
      if (retry) return retry;
      throw error;
    }
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
      throw new XeroApiError("Xero not connected for this organization — use Admin → Connect Xero");
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
      throw new XeroApiError("Xero client credentials missing");
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
      throw new XeroApiError(`Xero token refresh failed: ${body}`, { path: "/token" });
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
    if (!token.tenantId) {
      throw new XeroApiError("Xero tenant ID is missing — reconnect Xero in Admin → Integrations");
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token.accessToken}`,
      "xero-tenant-id": token.tenantId,
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(`${XERO_API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    if (!response.ok) {
      const apiError = new XeroApiError(this.formatXeroApiError(response.status, path, text), {
        status: response.status,
        path,
      });
      logger.error(
        { err: apiError, organizationId, path, status: response.status, body: text },
        "Xero API error"
      );
      throw apiError;
    }

    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  private formatXeroApiError(status: number, path: string, body: string): string {
    const lower = body.toLowerCase();
    const insufficientScope =
      lower.includes("insufficient_scope") ||
      lower.includes("authenticationunsuccessful") ||
      ((status === 401 || status === 403) && path.startsWith("/Items"));

    if (insufficientScope && path.startsWith("/Items")) {
      return "Xero refused to list items (missing accounting.settings scope). Reconnect Xero in Admin → Integrations so the new scope is granted.";
    }
    if (insufficientScope) {
      return `Xero API ${status}: insufficient scope. Reconnect Xero in Admin → Integrations.`;
    }

    let detail = body.trim();
    try {
      const parsed = JSON.parse(body) as {
        Title?: string;
        Detail?: string;
        Message?: string;
        Elements?: Array<{ ValidationErrors?: Array<{ Message?: string }> }>;
      };
      const elementErrors = parsed.Elements?.flatMap((element) => element.ValidationErrors ?? [])
        .map((error) => error.Message)
        .filter(Boolean)
        .join("; ");
      detail = elementErrors || parsed.Detail || parsed.Message || parsed.Title || detail;
    } catch {
      // keep raw body
    }

    return `Xero API ${status}: ${detail}`.slice(0, 400);
  }

  private async xeroApiUpload(
    organizationId: string,
    invoiceId: string,
    filename: string,
    buffer: Buffer,
    contentType: string
  ): Promise<void> {
    const token = await this.getValidToken(organizationId);
    const encodedName = encodeURIComponent(filename);
    const response = await fetch(
      `${XERO_API_BASE}/Invoices/${invoiceId}/Attachments/${encodedName}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          "xero-tenant-id": token.tenantId,
          Accept: "application/json",
          "Content-Type": contentType,
          "Content-Length": String(buffer.length),
        },
        body: buffer,
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new XeroApiError(`Xero attachment upload failed: ${response.status} ${text}`, {
        status: response.status,
        path: `/Invoices/${invoiceId}/Attachments`,
      });
    }
  }

  private isXeroUuid(value: string): boolean {
    return UUID_RE.test(value);
  }

  private async listAccounts(
    organizationId: string
  ): Promise<NonNullable<XeroAccountsResponse["Accounts"]>> {
    const result = await this.xeroApiRequest<XeroAccountsResponse>(organizationId, "GET", "/Accounts");
    return result.Accounts ?? [];
  }

  private async resolveBankAccountId(organizationId: string): Promise<string> {
    const cached = this.accountCache.get(organizationId)?.bankAccountId;
    if (cached) return cached;

    const accounts = await this.listAccounts(organizationId);
    const bank = accounts.find(
      (account) => account.Type === "BANK" && account.Status === "ACTIVE" && account.AccountID
    );
    if (!bank?.AccountID) {
      throw new XeroApiError(
        "Xero has no active bank account to record the payment against. Add a bank account in Xero Chart of Accounts, then try again."
      );
    }

    const entry = this.accountCache.get(organizationId) ?? {};
    entry.bankAccountId = bank.AccountID;
    this.accountCache.set(organizationId, entry);
    logger.info(
      { organizationId, bankCode: bank.Code, bankName: bank.Name },
      "Using Xero bank account for payment"
    );
    return bank.AccountID;
  }

  private async resolveExpenseAccountCode(organizationId: string): Promise<string> {
    const cached = this.accountCache.get(organizationId)?.expenseCode;
    if (cached) return cached;

    const accounts = await this.listAccounts(organizationId);
    const preferred = ["400", "429", "310", "453", "200"];
    const expenses = accounts.filter(
      (account) =>
        account.Status === "ACTIVE" &&
        Boolean(account.Code) &&
        (account.Type === "EXPENSE" || account.Type === "DIRECTCOSTS" || account.Class === "EXPENSE")
    );
    const match =
      preferred.map((code) => expenses.find((account) => account.Code === code)).find(Boolean) ??
      expenses[0];
    if (!match?.Code) {
      throw new XeroApiError(
        "Xero has no active expense account for bill line items. Add one in Chart of Accounts, then try again."
      );
    }

    const entry = this.accountCache.get(organizationId) ?? {};
    entry.expenseCode = match.Code;
    this.accountCache.set(organizationId, entry);
    return match.Code;
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
      throw new XeroApiError(
        "Supplier has no Xero contact yet. Add the supplier again in Admin so a Xero contact is created."
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
      throw new XeroApiError(
        `No Xero contact found for supplier "${contactName}". Add the supplier in Admin so a Xero contact is created.`
      );
    }

    logger.info(
      { organizationId, contactName, contactId: contact.ContactID },
      "Resolved Xero contact by name"
    );
    return contact.ContactID;
  }

  private extractPurchaseOrderValidationError(
    result: XeroPurchaseOrderResponse
  ): string | undefined {
    const po = result.PurchaseOrders?.[0];
    const poErrors = po?.ValidationErrors?.map((error) => error.Message).filter(Boolean);
    if (poErrors?.length) {
      return poErrors.join("; ");
    }
    if (po?.HasErrors) {
      return "Xero reported errors on the purchase order";
    }
    return result.Elements?.[0]?.ValidationErrors?.map((error) => error.Message).filter(Boolean)
      .join("; ");
  }

  private mapPurchaseOrder(po: XeroPurchaseOrderRecord): XeroOpenPurchaseOrder | null {
    if (!po.PurchaseOrderID) return null;
    return {
      xeroPoId: po.PurchaseOrderID,
      xeroPoNumber: po.PurchaseOrderNumber ?? po.PurchaseOrderID,
      date: (po.DateString ?? po.Date ?? "").slice(0, 10),
      status: po.Status ?? "AUTHORISED",
      total: Number(po.Total ?? 0),
      lineItems: (po.LineItems ?? []).map((line) => ({
        description: line.Description ?? "",
        itemCode: line.ItemCode,
        quantity: Number(line.Quantity ?? 0),
        unitAmount: Number(line.UnitAmount ?? 0),
      })),
    };
  }

  async getPurchaseOrderById(
    organizationId: string,
    purchaseOrderId: string
  ): Promise<XeroOpenPurchaseOrder> {
    if (purchaseOrderId.startsWith("DRY-") || !(await this.isConfiguredForOrg(organizationId))) {
      return {
        xeroPoId: purchaseOrderId,
        xeroPoNumber: purchaseOrderId,
        date: new Date().toISOString().slice(0, 10),
        status: "AUTHORISED",
        total: 0,
        lineItems: [],
      };
    }

    const result = await this.xeroApiRequest<XeroPurchaseOrderResponse>(
      organizationId,
      "GET",
      `/PurchaseOrders/${purchaseOrderId}`
    );

    const mapped = result.PurchaseOrders?.[0]
      ? this.mapPurchaseOrder(result.PurchaseOrders[0])
      : null;
    if (!mapped) {
      throw new XeroApiError("Xero purchase order number not found");
    }
    return mapped;
  }

  async createPurchaseOrder(
    organizationId: string,
    input: XeroPurchaseOrderInput
  ): Promise<{ xeroPoId: string; xeroPoNumber: string }> {
    if (!(await this.isConfiguredForOrg(organizationId))) {
      const mockId = input.purchaseOrderNumber ?? `DRY-PO-${Date.now()}`;
      logger.info({ organizationId, input, mockId }, "Xero not connected — mock PO created");
      return { xeroPoId: mockId, xeroPoNumber: mockId };
    }

    logger.info({ organizationId }, "Calling live Xero API to create purchase order");

    return withRetry(async () => {
      const contactId = await this.resolveContactId(
        organizationId,
        input.supplierContactId,
        input.contactName
      );

      const today = new Date().toISOString().slice(0, 10);
      const purchaseOrder: Record<string, unknown> = {
        Contact: { ContactID: contactId },
        Date: today,
        LineItems: input.lineItems.map((line) => ({
          Description: line.description,
          Quantity: line.quantity,
          UnitAmount: line.unitAmount,
          ...(line.itemCode && isPlausibleItemCode(line.itemCode) ? { ItemCode: line.itemCode } : {}),
        })),
        Status: "AUTHORISED",
      };

      if (input.purchaseOrderNumber) {
        purchaseOrder.PurchaseOrderNumber = input.purchaseOrderNumber;
      }

      const result = await this.xeroApiRequest<XeroPurchaseOrderResponse>(
        organizationId,
        "PUT",
        "/PurchaseOrders",
        { PurchaseOrders: [purchaseOrder] }
      );

      const validationError = this.extractPurchaseOrderValidationError(result);
      if (validationError) {
        throw new XeroApiError(`Xero purchase order validation failed: ${validationError}`);
      }

      const created = result.PurchaseOrders?.[0];
      if (!created?.PurchaseOrderID) {
        throw new XeroApiError("Xero did not return a Purchase Order ID");
      }

      const confirmed = await this.getPurchaseOrderById(organizationId, created.PurchaseOrderID);
      logger.info(
        { organizationId, xeroPoId: confirmed.xeroPoId, xeroOrderNumber: confirmed.xeroPoNumber },
        "Xero PO created"
      );
      return { xeroPoId: confirmed.xeroPoId, xeroPoNumber: confirmed.xeroPoNumber };
    });
  }

  async updatePurchaseOrder(
    organizationId: string,
    purchaseOrderId: string,
    input: XeroPurchaseOrderInput
  ): Promise<{ xeroPoId: string; xeroPoNumber: string; voidedAndRecreated?: boolean }> {
    if (purchaseOrderId.startsWith("DRY-") || !(await this.isConfiguredForOrg(organizationId))) {
      logger.info({ organizationId, purchaseOrderId, input }, "Xero not connected — mock PO update");
      return {
        xeroPoId: purchaseOrderId,
        xeroPoNumber: input.purchaseOrderNumber ?? purchaseOrderId,
      };
    }

    try {
      const existing = await this.getPurchaseOrderById(organizationId, purchaseOrderId);
      if (existing.status === "BILLED" || existing.status === "DELETED") {
        throw new XeroApiError(`PO not editable (${existing.status})`);
      }

      const contactId = await this.resolveContactId(
        organizationId,
        input.supplierContactId,
        input.contactName
      );
      const result = await this.xeroApiRequest<XeroPurchaseOrderResponse>(
        organizationId,
        "POST",
        "/PurchaseOrders",
        {
          PurchaseOrders: [
            {
              PurchaseOrderID: purchaseOrderId,
              Contact: { ContactID: contactId },
              LineItems: input.lineItems.map((line) => ({
                Description: line.description,
                Quantity: line.quantity,
                UnitAmount: line.unitAmount,
                ...(line.itemCode && isPlausibleItemCode(line.itemCode) ? { ItemCode: line.itemCode } : {}),
              })),
              Status: "AUTHORISED",
            },
          ],
        }
      );
      const validationError = this.extractPurchaseOrderValidationError(result);
      if (validationError) {
        throw new XeroApiError(`Xero purchase order validation failed: ${validationError}`);
      }
      const updated = result.PurchaseOrders?.[0];
      return {
        xeroPoId: updated?.PurchaseOrderID ?? purchaseOrderId,
        xeroPoNumber: updated?.PurchaseOrderNumber ?? existing.xeroPoNumber,
      };
    } catch (error) {
      logger.warn({ err: error, purchaseOrderId }, "PO update failed — voiding and recreating");
      await this.voidPurchaseOrder(organizationId, purchaseOrderId);
      const created = await this.createPurchaseOrder(organizationId, input);
      return { ...created, voidedAndRecreated: true };
    }
  }

  async voidPurchaseOrder(organizationId: string, purchaseOrderId: string): Promise<void> {
    if (purchaseOrderId.startsWith("DRY-") || !(await this.isConfiguredForOrg(organizationId))) {
      logger.info({ organizationId, purchaseOrderId }, "Xero not connected — mock PO void");
      return;
    }

    try {
      await this.xeroApiRequest(organizationId, "POST", "/PurchaseOrders", {
        PurchaseOrders: [{ PurchaseOrderID: purchaseOrderId, Status: "DELETED" }],
      });
    } catch (error) {
      logger.warn({ err: error, purchaseOrderId }, "Could not delete Xero PO");
    }
  }

  async convertPoToBill(
    organizationId: string,
    input: XeroBillInput
  ): Promise<{ xeroBillId: string }> {
    if (!(await this.isConfiguredForOrg(organizationId))) {
      const mockId = `DRY-BILL-${Date.now()}`;
      logger.info({ organizationId, input, mockId }, "Xero not connected — mock bill created");
      return { xeroBillId: mockId };
    }

    logger.info({ organizationId }, "Calling live Xero API to create bill");

    return withRetry(async () => {
      const contactId = await this.resolveContactId(
        organizationId,
        input.supplierContactId,
        input.contactName
      );
      const expenseCode = await this.resolveExpenseAccountCode(organizationId);
      const lineItems = input.lineItems
        .map((line) => ({
          Description: line.description,
          Quantity: line.quantity,
          UnitAmount: line.unitAmount,
          AccountCode: expenseCode,
          ...(line.itemCode && isPlausibleItemCode(line.itemCode) ? { ItemCode: line.itemCode } : {}),
        }))
        .filter((line) => line.Description && line.Quantity > 0);
      if (!lineItems.length) {
        throw new XeroApiError("Xero bill is missing line items — the invoice had no usable rows");
      }
      const result = await this.xeroApiRequest<XeroInvoicesResponse>(
        organizationId,
        "PUT",
        "/Invoices",
        {
          Invoices: [
            {
              Type: "ACCPAY",
              Contact: { ContactID: contactId },
              InvoiceNumber: input.invoiceNumber,
              Date: input.invoiceDate,
              DueDate: input.dueDate ?? input.invoiceDate,
              Reference: input.purchaseOrderNumber,
              Status: "AUTHORISED",
              LineItems: lineItems,
            },
          ],
        }
      );

      const created = result.Invoices?.[0];
      if (!created?.InvoiceID) {
        const errors = created?.ValidationErrors?.map((error) => error.Message).filter(Boolean);
        throw new XeroApiError(
          errors?.length ? `Xero bill validation failed: ${errors.join("; ")}` : "Xero bill not created"
        );
      }

      if (input.attachmentPath) {
        await this.attachInvoiceFile(
          organizationId,
          created.InvoiceID,
          input.attachmentPath,
          input.attachmentName
        );
      }

      return { xeroBillId: created.InvoiceID };
    });
  }

  async attachInvoiceFile(
    organizationId: string,
    xeroBillId: string,
    filePath: string,
    filename?: string
  ): Promise<void> {
    if (!(await this.isConfiguredForOrg(organizationId))) {
      logger.info({ organizationId, xeroBillId, filePath }, "Xero not connected — attachment skipped");
      return;
    }
    if (xeroBillId.startsWith("DRY-")) return;

    const buffer = await fs.readFile(filePath);
    const name = filename ?? path.basename(filePath);
    const ext = path.extname(name).toLowerCase();
    const contentType =
      ext === ".pdf"
        ? "application/pdf"
        : ext === ".png"
          ? "image/png"
          : "image/jpeg";
    await this.xeroApiUpload(organizationId, xeroBillId, name, buffer, contentType);
  }

  async findDuplicateBill(
    organizationId: string,
    supplierContactId: string,
    invoiceNumber: string
  ): Promise<boolean> {
    const local = await prisma.xeroBill.findFirst({
      where: {
        invoiceNumber,
        supplier: { organizationId },
      },
    });
    if (local) return true;

    if (!(await this.isConfiguredForOrg(organizationId))) {
      return false;
    }

    const escaped = invoiceNumber.replace(/"/g, '\\"');
    const contactFilter = this.isXeroUuid(supplierContactId)
      ? ` AND Contact.ContactID==Guid("${supplierContactId}")`
      : "";
    const result = await this.xeroApiRequest<XeroInvoicesResponse>(
      organizationId,
      "GET",
      `/Invoices?where=Type=="ACCPAY" AND InvoiceNumber=="${escaped}"${contactFilter}`
    );
    return (result.Invoices ?? []).length > 0;
  }

  async updateBillStatus(
    organizationId: string,
    xeroBillId: string,
    status: "AWAITING_PAYMENT" | "PAID",
    note?: string
  ): Promise<void> {
    if (!(await this.isConfiguredForOrg(organizationId))) {
      logger.info({ organizationId, xeroBillId, status, note }, "Xero not connected — bill status skipped");
      return;
    }
    if (xeroBillId.startsWith("DRY-")) return;

    await withRetry(async () => {
      if (status === "AWAITING_PAYMENT") {
        await this.xeroApiRequest(organizationId, "POST", "/Invoices", {
          Invoices: [{ InvoiceID: xeroBillId, Status: "AUTHORISED" }],
        });
        return;
      }

      const invoice = await this.xeroApiRequest<XeroInvoicesResponse>(
        organizationId,
        "GET",
        `/Invoices/${xeroBillId}`
      );
      const amount = invoice.Invoices?.[0]?.AmountDue ?? invoice.Invoices?.[0]?.Total ?? 0;
      const bankAccountId = await this.resolveBankAccountId(organizationId);
      await this.xeroApiRequest(organizationId, "PUT", "/Payments", {
        Payments: [
          {
            Invoice: { InvoiceID: xeroBillId },
            Account: { AccountID: bankAccountId },
            Date: new Date().toISOString().slice(0, 10),
            Amount: amount,
            Reference: note,
          },
        ],
      });
    });
  }

  async getOpenPurchaseOrders(
    organizationId: string,
    supplierContactId: string,
    beforeDate: Date
  ): Promise<XeroOpenPurchaseOrder[]> {
    const local = await prisma.purchaseOrder.findMany({
      where: {
        status: { in: ["SUBMITTED", "AUTHORISED"] },
        bills: { none: {} },
        supplier: {
          organizationId,
          OR: [{ xeroContactId: supplierContactId }, { id: supplierContactId }],
        },
      },
      include: { lines: true },
      orderBy: { createdAt: "desc" },
    });

    const fromLocal: XeroOpenPurchaseOrder[] = local
      .filter((po) => isWithinDaysBefore(po.createdAt, beforeDate))
      .map((po) => ({
        xeroPoId: po.xeroPoId ?? po.id,
        xeroPoNumber: po.xeroPoNumber ?? po.id,
        date: po.createdAt.toISOString().slice(0, 10),
        status: po.status,
        total: Number(po.totalAmount ?? 0),
        lineItems: po.lines.map((line) => ({
          description: line.itemName,
          itemCode: line.xeroItemId ?? undefined,
          quantity: Number(line.quantity),
          unitAmount: Number(line.unitPrice ?? 0),
        })),
      }));

    if (!(await this.isConfiguredForOrg(organizationId))) {
      return fromLocal;
    }

    try {
      const contactId = this.isXeroUuid(supplierContactId)
        ? supplierContactId
        : await this.resolveContactId(organizationId, supplierContactId);
      const result = await this.xeroApiRequest<XeroPurchaseOrderResponse>(
        organizationId,
        "GET",
        `/PurchaseOrders?where=Contact.ContactID==Guid("${contactId}") AND Status=="AUTHORISED"`
      );
      const fromXero = (result.PurchaseOrders ?? [])
        .map((po) => this.mapPurchaseOrder(po))
        .filter((po): po is XeroOpenPurchaseOrder => Boolean(po))
        .filter((po) => {
          const date = po.date ? new Date(po.date) : new Date();
          return isWithinDaysBefore(date, beforeDate);
        });
      return fromXero.length ? fromXero : fromLocal;
    } catch (error) {
      logger.warn({ err: error }, "Falling back to local open POs");
      await notifySupervisorOfXeroError("look up open purchase orders", error);
      return fromLocal;
    }
  }

  async getBillsForPeriod(
    organizationId: string,
    supplierContactId: string,
    start: Date,
    end: Date
  ): Promise<XeroBillRecord[]> {
    const { unpaid } = await this.getReconciliationBillsForPeriod(
      organizationId,
      supplierContactId,
      start,
      end
    );
    return unpaid;
  }

  async getReconciliationBillsForPeriod(
    organizationId: string,
    supplierContactId: string,
    start: Date,
    end: Date
  ): Promise<{ unpaid: XeroBillRecord[]; paid: XeroBillRecord[] }> {
    const localUnpaid = await prisma.xeroBill.findMany({
      where: {
        invoiceDate: { gte: start, lte: end },
        status: { in: ["SUBMITTED", "AWAITING_PAYMENT"] },
        supplier: {
          organizationId,
          OR: [{ xeroContactId: supplierContactId }, { id: supplierContactId }],
        },
      },
    });
    const localPaid = await prisma.xeroBill.findMany({
      where: {
        invoiceDate: { gte: start, lte: end },
        status: "PAID",
        supplier: {
          organizationId,
          OR: [{ xeroContactId: supplierContactId }, { id: supplierContactId }],
        },
      },
    });
    const mapLocal = (bill: (typeof localUnpaid)[number]): XeroBillRecord => ({
      xeroBillId: bill.xeroBillId ?? bill.id,
      invoiceNumber: bill.invoiceNumber ?? "UNKNOWN",
      invoiceDate: (bill.invoiceDate ?? bill.createdAt).toISOString().slice(0, 10),
      total: Number(bill.totalAmount ?? 0),
      status: bill.status,
    });
    const fromLocal = {
      unpaid: localUnpaid.map(mapLocal),
      paid: localPaid.map(mapLocal),
    };

    if (!(await this.isConfiguredForOrg(organizationId))) {
      return fromLocal;
    }

    try {
      const contactId = this.isXeroUuid(supplierContactId)
        ? supplierContactId
        : await this.resolveContactId(organizationId, supplierContactId);
      const startStr = start.toISOString().slice(0, 10);
      const endStr = end.toISOString().slice(0, 10);
      const result = await this.xeroApiRequest<XeroInvoicesResponse>(
        organizationId,
        "GET",
        `/Invoices?where=Type=="ACCPAY" AND Contact.ContactID==Guid("${contactId}") AND Date>=DateTime(${startStr.replaceAll("-", ",")}) AND Date<=DateTime(${endStr.replaceAll("-", ",")}) AND Status!="VOIDED" AND Status!="DELETED"`
      );
      const unpaid: XeroBillRecord[] = [];
      const paid: XeroBillRecord[] = [];
      for (const invoice of result.Invoices ?? []) {
        if (!invoice.InvoiceID) continue;
        const status = (invoice.Status ?? "").toUpperCase();
        if (status === "VOIDED" || status === "DELETED") continue;
        const amountDue = invoice.AmountDue;
        const isPaid = status === "PAID" || (amountDue != null && amountDue <= 0);
        const row: XeroBillRecord = {
          xeroBillId: invoice.InvoiceID,
          invoiceNumber: invoice.InvoiceNumber ?? "UNKNOWN",
          invoiceDate: (invoice.DateString ?? invoice.Date ?? "").slice(0, 10),
          total: Number(
            !isPaid && amountDue != null && amountDue > 0 ? amountDue : invoice.Total ?? 0
          ),
          status: invoice.Status ?? "AUTHORISED",
        };
        if (isPaid) paid.push(row);
        else unpaid.push(row);
      }
      return { unpaid, paid };
    } catch (error) {
      logger.warn({ err: error }, "Falling back to local bills for period");
      await notifySupervisorOfXeroError("look up bills for reconciliation", error);
      return fromLocal;
    }
  }
}

export const xeroService = new XeroService();
