import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { getOrganizationId } from "../context/tenant.js";
import { integrationConfigService } from "./integration-config.service.js";
import type { PayableList } from "../types/index.js";

export interface DbsPaymentResult {
  transactionRef: string;
  status: "raised" | "approved" | "failed";
}

class DbsPlaywrightService {
  async raisePayment(payable: PayableList): Promise<DbsPaymentResult> {
    const organizationId = getOrganizationId();
    const dbs = await integrationConfigService.getDbs(organizationId);

    if (config.DRY_RUN) {
      const ref = `DRY-DBS-${Date.now()}`;
      logger.info({ organizationId, payable, ref, dbsOrgId: dbs.orgId }, "[DRY_RUN] DBS payment raised");
      return { transactionRef: ref, status: "raised" };
    }

    if (!integrationConfigService.isDbsConfigured(dbs)) {
      throw new Error("DBS integration not configured for this organization");
    }

    logger.warn({ organizationId }, "DBS Playwright macro not yet configured");
    throw new Error("DBS Playwright integration pending configuration");
  }

  async checkPaymentApproval(transactionRef: string): Promise<boolean> {
    if (config.DRY_RUN) {
      logger.info({ transactionRef }, "[DRY_RUN] DBS approval check");
      return false;
    }
    return false;
  }

  async isSessionAvailable(): Promise<boolean> {
    return true;
  }
}

export const dbsPlaywrightService = new DbsPlaywrightService();
