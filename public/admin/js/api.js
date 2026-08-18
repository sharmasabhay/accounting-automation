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
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
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

  getWorkflows(slug) {
    return this.request(`/api/organizations/${slug}/workflows`);
  },

  testPoIntake(slug, message) {
    return this.request(`/api/organizations/${slug}/test/po-intake`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  },

  testWhatsAppWebhook(slug, message) {
    return this.request(`/api/organizations/${slug}/test/whatsapp-webhook`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  },

  getSchemas() {
    return this.request("/api/admin/integration-schemas");
  },
};

window.api = api;
