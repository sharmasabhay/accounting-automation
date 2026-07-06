import { AsyncLocalStorage } from "node:async_hooks";

export interface TenantContext {
  organizationId: string;
  organizationSlug?: string;
}

const tenantStorage = new AsyncLocalStorage<TenantContext>();

export function getTenant(): TenantContext {
  const ctx = tenantStorage.getStore();
  if (!ctx) {
    throw new Error("No organization context — wrap call in withOrganization()");
  }
  return ctx;
}

export function getOrganizationId(): string {
  return getTenant().organizationId;
}

export function tryGetOrganizationId(): string | undefined {
  return tenantStorage.getStore()?.organizationId;
}

export async function withOrganization<T>(
  organizationId: string,
  fn: () => Promise<T>,
  organizationSlug?: string
): Promise<T> {
  return tenantStorage.run({ organizationId, organizationSlug }, fn);
}
