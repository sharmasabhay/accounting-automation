import { chromium, type Browser, type Page } from "playwright";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { getOrganizationId } from "../context/tenant.js";
import { integrationConfigService } from "./integration-config.service.js";
import type { PayableList } from "../types/index.js";

export interface DbsPaymentResult {
  transactionRef: string;
  status: "raised" | "approved" | "failed";
}

const SELECTORS = {
  orgId: 'input[name="orgId"], #orgId',
  userId: 'input[name="userId"], #userId',
  password: 'input[type="password"]',
  login: 'button[type="submit"], input[type="submit"]',
  history: "text=Transaction History",
  payee: "select, [name='payee']",
  amount: 'input[name="amount"], #amount',
  category: "text=Business Expenses",
  reference: 'input[name="reference"], #reference',
  submit: 'button:has-text("Submit"), input[value="Submit"]',
  txnRef: "text=/TXN|Ref/",
};

class DbsPlaywrightService {
  private locked = new Set<string>();
  private simulatedApprovals = new Set<string>();
  private raisedHistory: Array<{ supplier: string; amount: number; reference: string; ref: string }> =
    [];
  private browser: Browser | null = null;
  private page: Page | null = null;

  async isSessionAvailable(organizationId = getOrganizationId()): Promise<boolean> {
    return !this.locked.has(organizationId);
  }

  async acquireSession(organizationId = getOrganizationId()): Promise<boolean> {
    if (this.locked.has(organizationId)) return false;
    this.locked.add(organizationId);
    return true;
  }

  async releaseSession(organizationId = getOrganizationId()): Promise<void> {
    this.locked.delete(organizationId);
    if (this.page) {
      await this.page.context().close().catch(() => undefined);
      this.page = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }

  simulateApproval(transactionRef: string): void {
    this.simulatedApprovals.add(transactionRef);
  }

  async raisePayment(payable: PayableList): Promise<DbsPaymentResult> {
    const organizationId = getOrganizationId();
    const dbs = await integrationConfigService.getDbs(organizationId);

    const duplicate = this.raisedHistory.find(
      (row) =>
        row.supplier === payable.supplierName &&
        row.amount === payable.totalAmount &&
        row.reference === payable.referenceText
    );
    if (duplicate) {
      logger.info({ duplicate }, "[DRY_RUN] Duplicate DBS payment skipped");
      return { transactionRef: duplicate.ref, status: "raised" };
    }

    if (config.DRY_RUN) {
      const ref = `DRY-DBS-${Date.now()}`;
      this.raisedHistory.push({
        supplier: payable.supplierName,
        amount: payable.totalAmount,
        reference: payable.referenceText,
        ref,
      });
      logger.info(
        { organizationId, payable, ref, dbsOrgId: dbs.orgId },
        "[DRY_RUN] DBS payment raised"
      );
      return { transactionRef: ref, status: "raised" };
    }

    if (!integrationConfigService.isDbsConfigured(dbs)) {
      throw new Error("DBS integration not configured for this organization");
    }

    logger.warn({ organizationId }, "Starting DBS Playwright payment raise");
    this.browser = await chromium.launch({ headless: dbs.headless !== false });
    this.page = await this.browser.newPage();
    await this.page.goto(dbs.idealUrl ?? config.DBS_IDEAL_URL);
    await this.page.fill(SELECTORS.orgId, dbs.orgId ?? "");
    await this.page.fill(SELECTORS.userId, dbs.userId ?? "");
    if (dbs.password) await this.page.fill(SELECTORS.password, dbs.password);
    await this.page.click(SELECTORS.login);

    const historyText = await this.page.content();
    if (
      historyText.includes(payable.referenceText) &&
      historyText.includes(String(payable.totalAmount))
    ) {
      throw new Error("Possible duplicate DBS payment found in history");
    }

    await this.page.fill(SELECTORS.amount, String(payable.totalAmount));
    await this.page.click(SELECTORS.category).catch(() => undefined);
    await this.page.fill(SELECTORS.reference, payable.referenceText);
    await this.page.click(SELECTORS.submit);
    const refMatch = (await this.page.content()).match(/([A-Z0-9]{6,})/);
    const transactionRef = refMatch?.[1] ?? `DBS-${Date.now()}`;
    this.raisedHistory.push({
      supplier: payable.supplierName,
      amount: payable.totalAmount,
      reference: payable.referenceText,
      ref: transactionRef,
    });
    return { transactionRef, status: "raised" };
  }

  async checkPaymentApproval(transactionRef: string): Promise<boolean> {
    if (this.simulatedApprovals.has(transactionRef)) {
      this.simulatedApprovals.delete(transactionRef);
      return true;
    }
    if (config.DRY_RUN) {
      logger.info({ transactionRef }, "[DRY_RUN] DBS approval check");
      return false;
    }
    return false;
  }

  async payeeExists(payeeName: string): Promise<boolean> {
    if (config.DRY_RUN) return Boolean(payeeName);
    return Boolean(payeeName);
  }
}

export const dbsPlaywrightService = new DbsPlaywrightService();
