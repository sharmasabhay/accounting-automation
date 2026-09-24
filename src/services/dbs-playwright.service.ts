import fs from "node:fs";
import path from "node:path";
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

  private approvalsFile(): string {
    return path.join(config.storagePath, "dbs-simulated-approvals.json");
  }

  private loadPersistedApprovals(): Set<string> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.approvalsFile(), "utf8")) as string[];
      return new Set(Array.isArray(raw) ? raw : []);
    } catch {
      return new Set();
    }
  }

  private persistApprovals(refs: Set<string>): void {
    fs.mkdirSync(config.storagePath, { recursive: true });
    fs.writeFileSync(this.approvalsFile(), JSON.stringify([...refs], null, 2));
  }

  simulateApproval(transactionRef: string): void {
    this.simulatedApprovals.add(transactionRef);
    const persisted = this.loadPersistedApprovals();
    persisted.add(transactionRef);
    this.persistApprovals(persisted);
  }

  private demoBankUrl(payeeName: string): string {
    const host = config.HOST === "0.0.0.0" || config.HOST === "::" ? "127.0.0.1" : config.HOST;
    const url = new URL(`http://${host}:${config.PORT}/admin/dbs-ideal-demo.html`);
    url.searchParams.set("payee", payeeName);
    return url.toString();
  }

  private async launchBrowser(headless: boolean): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
      this.page = null;
    }
    const display = process.env.DISPLAY || ":1";
    const launchOptions = {
      headless,
      slowMo: headless ? 0 : 400,
      chromiumSandbox: false,
      env: {
        ...process.env,
        DISPLAY: display,
      },
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--start-maximized"],
    };
    logger.info({ headless, display, xauthority: process.env.XAUTHORITY }, "Launching Chrome for DBS demo");
    try {
      this.browser = await chromium.launch({ ...launchOptions, channel: "chrome" });
    } catch (chromeError) {
      logger.warn({ err: chromeError }, "System Chrome launch failed — trying Playwright Chromium");
      this.browser = await chromium.launch(launchOptions);
    }
    this.page = await this.browser.newPage({ viewport: { width: 1100, height: 820 } });
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
      logger.info({ duplicate }, "Duplicate DBS payment skipped");
      return { transactionRef: duplicate.ref, status: "raised" };
    }

    const useDemo = config.DRY_RUN;
    if (!useDemo && !integrationConfigService.isDbsConfigured(dbs)) {
      throw new Error("DBS integration not configured for this organization");
    }

    const idealUrl = useDemo
      ? this.demoBankUrl(payable.supplierName)
      : (dbs.idealUrl ?? config.DBS_IDEAL_URL);

    logger.info(
      { organizationId, idealUrl, display: process.env.DISPLAY, demo: useDemo },
      useDemo
        ? "Opening a visible Chrome window on the local IDEAL demo (not real DBS)"
        : "Starting DBS Playwright payment raise"
    );

    try {
      await this.launchBrowser(false);
    } catch (error) {
      logger.warn({ err: error }, "Visible Chrome failed — retrying headless so the payment can still complete");
      await this.launchBrowser(true);
    }

    if (!this.page) throw new Error("Playwright page was not created");

    await this.page.goto(idealUrl, { waitUntil: "domcontentloaded" });
    await this.page.fill(SELECTORS.orgId, dbs.orgId ?? "DEMO");
    await this.page.fill(SELECTORS.userId, dbs.userId ?? "DEMO");
    await this.page.fill(SELECTORS.password, dbs.password ?? "demo");
    await this.page.locator("#login-form button[type='submit']").click();
    await this.page.waitForSelector("#payee", { timeout: 20_000 });

    const historyText = await this.page.content();
    if (
      historyText.includes(payable.referenceText) &&
      historyText.includes(String(payable.totalAmount))
    ) {
      throw new Error("Possible duplicate DBS payment found in history");
    }

    const payee = this.page.locator("#payee");
    if ((await payee.count()) > 0) {
      await payee.selectOption({ label: payable.supplierName }).catch(async () => {
        await payee.selectOption({ index: 0 });
      });
    }

    await this.page.fill(SELECTORS.amount, String(payable.totalAmount));
    await this.page.locator("#purpose-biz").click().catch(() => undefined);
    await this.page.fill(SELECTORS.reference, payable.referenceText);
    await this.page.locator("#submit-pay").click();
    await this.page.waitForSelector("#txnRef", { timeout: 15_000 });
    const transactionRef = (await this.page.locator("#txnRef").innerText()).trim();
    await this.page.waitForTimeout(8000);

    this.raisedHistory.push({
      supplier: payable.supplierName,
      amount: payable.totalAmount,
      reference: payable.referenceText,
      ref: transactionRef,
    });
    logger.info({ organizationId, payable, transactionRef, demo: useDemo }, "DBS payment raised");
    return { transactionRef, status: "raised" };
  }

  async checkPaymentApproval(transactionRef: string): Promise<boolean> {
    if (this.simulatedApprovals.has(transactionRef)) {
      this.simulatedApprovals.delete(transactionRef);
      const persisted = this.loadPersistedApprovals();
      persisted.delete(transactionRef);
      this.persistApprovals(persisted);
      return true;
    }
    const persisted = this.loadPersistedApprovals();
    if (persisted.has(transactionRef)) {
      persisted.delete(transactionRef);
      this.persistApprovals(persisted);
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
