const TOKEN_KEY = "omakase_api_token";

const api = {
  getToken() {
    return localStorage.getItem(TOKEN_KEY) || "";
  },

  setToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
  },

  clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  },

  async requestForm(path, formData) {
    const token = this.getToken();
    const res = await fetch(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    if (res.status === 401) {
      this.clearToken();
      window.location.reload();
      throw new Error("Unauthorized");
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || data.message || `Request failed (${res.status})`);
    }
    return data;
  },

  async request(path, options = {}) {
    const token = this.getToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    };
    if (options.body) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(path, {
      ...options,
      headers,
    });

    if (res.status === 401) {
      this.clearToken();
      window.location.reload();
      throw new Error("Unauthorized");
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || data.message || `Request failed (${res.status})`);
    }
    return data;
  },

  listOrgs() {
    return this.request("/api/organizations");
  },

  getOrg(slug) {
    return this.request(`/api/organizations/${slug}`);
  },

  createOrg(body) {
    return this.request("/api/organizations", { method: "POST", body: JSON.stringify(body) });
  },

  updateOrg(slug, body) {
    return this.request(`/api/organizations/${slug}`, { method: "PATCH", body: JSON.stringify(body) });
  },

  addTeamMember(slug, body) {
    return this.request(`/api/organizations/${slug}/team-members`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  removeTeamMember(slug, memberId) {
    return this.request(`/api/organizations/${slug}/team-members/${memberId}`, {
      method: "DELETE",
    });
  },

  addSupplier(slug, body) {
    return this.request(`/api/organizations/${slug}/suppliers`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  removeSupplier(slug, supplierId) {
    return this.request(`/api/organizations/${slug}/suppliers/${supplierId}`, {
      method: "DELETE",
    });
  },

  updateSupplier(slug, supplierId, body) {
    return this.request(`/api/organizations/${slug}/suppliers/${supplierId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  },

  importXeroSuppliers(slug, contactIds) {
    return this.request(`/api/organizations/${slug}/suppliers/import-xero`, {
      method: "POST",
      body: JSON.stringify(contactIds?.length ? { contactIds } : {}),
    });
  },

  getIntegrations(slug) {
    return this.request(`/api/organizations/${slug}/integrations`);
  },

  saveIntegration(slug, type, config) {
    return this.request(`/api/organizations/${slug}/integrations/${type}`, {
      method: "PUT",
      body: JSON.stringify(config),
    });
  },

  xeroConnect(slug) {
    return this.request(`/api/organizations/${slug}/integrations/xero/connect`);
  },

  getWhatsAppOnboarding(slug) {
    return this.request(`/api/organizations/${slug}/whatsapp/onboarding`);
  },

  generateWhatsAppOnboardingLink(slug) {
    return this.request(`/api/organizations/${slug}/whatsapp/onboarding-link`, {
      method: "POST",
    });
  },

  listXeroContacts(slug) {
    return this.request(`/api/organizations/${slug}/xero/contacts`);
  },

  listXeroItems(slug) {
    return this.request(`/api/organizations/${slug}/xero/items`);
  },

  addSkuMapping(slug, supplierId, body) {
    return this.request(`/api/organizations/${slug}/suppliers/${supplierId}/sku-mappings`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  removeSkuMapping(slug, supplierId, mappingId) {
    return this.request(`/api/organizations/${slug}/suppliers/${supplierId}/sku-mappings/${mappingId}`, {
      method: "DELETE",
    });
  },

  resetOperational(slug) {
    return this.request(`/api/organizations/${slug}/test/reset-operational`, {
      method: "POST",
      body: "{}",
    });
  },

  getWorkflows(slug) {
    return this.request(`/api/organizations/${slug}/workflows`);
  },

  getConversations(slug) {
    return this.request(`/api/organizations/${slug}/conversations`);
  },

  replyConversation(slug, body) {
    return this.request(`/api/organizations/${slug}/conversations/reply`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  clearConversations(slug) {
    return this.request(`/api/organizations/${slug}/conversations`, {
      method: "DELETE",
    });
  },

  testPoIntake(slug, message) {
    return this.request(`/api/organizations/${slug}/test/po-intake`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  },

  testWhatsAppWebhook(slug, message, extra = {}) {
    return this.request(`/api/organizations/${slug}/test/whatsapp-webhook`, {
      method: "POST",
      body: JSON.stringify({ message, ...extra }),
    });
  },

  getPurchaseOrders(slug) {
    return this.request(`/api/organizations/${slug}/purchase-orders`);
  },

  testInvoice(slug, fileList) {
    const fd = new FormData();
    for (const file of fileList) fd.append("files", file);
    return this.requestForm(`/api/organizations/${slug}/test/invoice`, fd);
  },

  testEmailScan(slug, body = {}) {
    const fd = new FormData();
    for (const file of body.files || []) fd.append("files", file);
    if (body.from) fd.append("from", body.from);
    if (body.subject) fd.append("subject", body.subject);
    if (body.kind) fd.append("kind", body.kind);
    return this.requestForm(`/api/organizations/${slug}/test/email-scan`, fd);
  },

  scanLiveInbox(slug) {
    return this.request(`/api/organizations/${slug}/test/email-inbox`, { method: "POST" });
  },

  testReconcile(slug, message) {
    return this.request(`/api/organizations/${slug}/test/reconcile`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  },

  testDbsApprove(slug, transactionRef) {
    return this.request(`/api/organizations/${slug}/test/dbs-approve`, {
      method: "POST",
      body: JSON.stringify({ transactionRef }),
    });
  },

  getSchemas() {
    return this.request("/api/admin/integration-schemas");
  },
};

window.api = api;
