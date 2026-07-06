let currentOrg = null;
let integrationSchemas = null;

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 3000);
}

function showApp() {
  document.getElementById("login-overlay").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
}

async function verifyToken() {
  await api.listOrgs();
  showApp();
}

function initLogin() {
  const token = api.getToken();
  if (token) {
    verifyToken().catch(() => {
      document.getElementById("login-overlay").classList.remove("hidden");
    });
  } else {
    document.getElementById("login-overlay").classList.remove("hidden");
  }

  document.getElementById("login-btn").onclick = async () => {
    const token = document.getElementById("login-token").value.trim();
    const err = document.getElementById("login-error");
    if (!token) return;
    api.setToken(token);
    try {
      await verifyToken();
      err.classList.add("hidden");
      route();
    } catch {
      api.clearToken();
      err.textContent = "Invalid API token";
      err.classList.remove("hidden");
    }
  };

  document.getElementById("logout-btn").onclick = () => {
    api.clearToken();
    location.reload();
  };
}

function hideViews() {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
}

async function renderList() {
  hideViews();
  document.getElementById("view-list").classList.remove("hidden");
  const orgs = await api.listOrgs();
  const container = document.getElementById("org-list");

  if (!orgs.length) {
    container.innerHTML = `<div class="card"><p class="muted">No organizations yet. <a href="#/new">Onboard one</a>.</p></div>`;
    return;
  }

  container.innerHTML = orgs
    .map(
      (o) => `
    <a href="#/org/${o.slug}" class="card org-card" style="text-decoration:none;color:inherit">
      <h3>${esc(o.name)}</h3>
      <div class="slug">${esc(o.slug)}</div>
      <p class="muted" style="margin-top:.5rem">${esc(o.timezone)}</p>
      <span class="badge ${o.isActive ? "ok" : "off"}">${o.isActive ? "Active" : "Inactive"}</span>
    </a>`
    )
    .join("");
}

function renderNew() {
  hideViews();
  document.getElementById("view-new").classList.remove("hidden");
}

async function renderOrg(slug) {
  hideViews();
  document.getElementById("view-org").classList.remove("hidden");

  currentOrg = await api.getOrg(slug);
  document.getElementById("org-title").textContent = currentOrg.name;
  document.getElementById("org-subtitle").textContent = `${currentOrg.slug} · ${currentOrg.id}`;

  document.getElementById("edit-name").value = currentOrg.name;
  document.getElementById("edit-timezone").value = currentOrg.timezone;
  document.getElementById("edit-active").checked = currentOrg.isActive;

  closeEditSupplier();
  renderTeamTable();
  renderSupplierTable();
    await renderIntegrations();
    await renderWorkflows();
    document.getElementById("load-xero-contacts-btn")?.addEventListener("click", loadXeroContacts);
  }

function renderTeamTable() {
  const el = document.getElementById("team-list");
  const rows = currentOrg.teamMembers
    .map(
      (m) => `<tr>
      <td>${esc(m.name)}</td>
      <td><code>${esc(m.phoneNumber)}</code></td>
      <td><span class="badge ${m.role === "SUPERVISOR" ? "ok" : "off"}">${m.role}</span></td>
      <td class="actions-cell">
        <button type="button" class="btn sm danger remove-member-btn" data-id="${esc(m.id)}" data-name="${esc(m.name)}" data-role="${esc(m.role)}">
          Remove
        </button>
      </td>
    </tr>`
    )
    .join("");

  el.innerHTML = `<table>
    <thead><tr><th>Name</th><th>Phone</th><th>Role</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="muted">No team members</td></tr>'}</tbody>
  </table>`;
}

function renderSupplierTable() {
  const el = document.getElementById("supplier-list");
  const rows = currentOrg.suppliers
    .map(
      (s) => `<tr>
      <td>${esc(s.name)}</td>
      <td><code>${esc(s.xeroContactId || "—")}</code></td>
      <td>${esc(s.emailDomain || "—")}</td>
      <td>${esc(s.whatsappGroupId || "—")}</td>
      <td>${esc(s.dbsPayeeName || "—")}</td>
      <td class="actions-cell">
        <button type="button" class="btn sm edit-supplier-btn" data-id="${esc(s.id)}">Edit</button>
        <button type="button" class="btn sm danger remove-supplier-btn" data-id="${esc(s.id)}" data-name="${esc(s.name)}">
          Remove
        </button>
      </td>
    </tr>`
    )
    .join("");

  el.innerHTML = `<table>
    <thead><tr><th>Name</th><th>Xero Contact ID</th><th>Email domain</th><th>WA Group</th><th>DBS Payee</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="muted">No suppliers</td></tr>'}</tbody>
  </table>`;
}

function openEditSupplier(supplierId) {
  const supplier = currentOrg?.suppliers.find((s) => s.id === supplierId);
  if (!supplier) return;

  const form = document.getElementById("edit-supplier-form");
  document.getElementById("edit-supplier-id").value = supplier.id;

  for (const field of ["name", "emailDomain", "whatsappGroupId", "dbsPayeeName", "xeroContactId"]) {
    const input = form.querySelector(`[name="${field}"]`);
    if (input) input.value = supplier[field] || "";
  }

  form.classList.remove("hidden");
  form.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeEditSupplier() {
  const form = document.getElementById("edit-supplier-form");
  form.classList.add("hidden");
  form.reset();
}

async function loadXeroContacts() {
  const btn = document.getElementById("load-xero-contacts-btn");
  const el = document.getElementById("xero-contacts-list");
  if (!currentOrg || !btn || !el) return;

  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    const { contacts, tenantId } = await api.listXeroContacts(currentOrg.slug);
    if (!contacts.length) {
      el.innerHTML = `<p class="muted">No supplier contacts found in Xero (tenant: ${esc(tenantId || "")}). Create suppliers in Xero under Contacts first.</p>`;
      return;
    }

    const rows = contacts
      .map(
        (c) => `<tr>
        <td>${esc(c.name)}</td>
        <td><code class="copy-contact-id" title="Click to copy">${esc(c.contactId)}</code></td>
        <td>${esc(c.email || "—")}</td>
      </tr>`
      )
      .join("");

    el.innerHTML = `<table>
      <thead><tr><th>Name in Xero</th><th>Contact ID (click to copy)</th><th>Email</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

    el.querySelectorAll(".copy-contact-id").forEach((cell) => {
      cell.style.cursor = "pointer";
      cell.onclick = () => {
        navigator.clipboard.writeText(cell.textContent);
        showToast("Contact ID copied — paste into supplier form");
      };
    });
  } catch (err) {
    el.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Load contacts from Xero";
  }
}

async function renderIntegrations() {
  if (!integrationSchemas) {
    integrationSchemas = await api.getSchemas();
  }

  const data = await api.getIntegrations(currentOrg.slug);
  const configByType = {};
  data.integrations.forEach((i) => {
    configByType[i.type] = i.config;
  });

  const types = ["XERO", "WHATSAPP", "EMAIL", "DBS", "OCR"];
  const labels = {
    XERO: "Xero Accounting",
    WHATSAPP: "WhatsApp Business",
    EMAIL: "Email (IMAP)",
    DBS: "DBS IDEAL",
    OCR: "OCR / Document AI",
  };

  const container = document.getElementById("integration-panels");
  container.innerHTML = types
    .map((type) => {
      const fields = integrationSchemas[type] || [];
      const cfg = configByType[type] || {};
      const status = getIntegrationStatus(type, cfg, data.xeroStatus);

      const fieldsHtml = fields
        .map((f) => {
          const val = cfg[f.key] ?? "";
          if (f.type === "boolean") {
            return `<div class="form-row">
              <label class="checkbox-label">
                <input type="checkbox" name="${f.key}" ${val ? "checked" : ""} />
                ${esc(f.label)}
              </label>
              ${f.help ? `<div class="field-help">${esc(f.help)}</div>` : ""}
            </div>`;
          }
          if (f.type === "select") {
            const opts = (f.options || [])
              .map((o) => `<option value="${o}" ${val === o ? "selected" : ""}>${o}</option>`)
              .join("");
            return `<div class="form-row">
              <label>${esc(f.label)}</label>
              <select name="${f.key}"><option value="">—</option>${opts}</select>
              ${f.help ? `<div class="field-help">${esc(f.help)}</div>` : ""}
            </div>`;
          }
          return `<div class="form-row">
            <label>${esc(f.label)}</label>
            <input type="${f.type}" name="${f.key}" value="${esc(String(val))}" placeholder="${f.type === "password" ? "Leave blank to keep existing" : ""}" />
            ${f.help ? `<div class="field-help">${esc(f.help)}</div>` : ""}
          </div>`;
        })
        .join("");

      const xeroSetup =
        type === "XERO"
          ? `<div class="xero-setup-box">
              <strong>Before connecting:</strong>
              <ol>
                <li>Go to <a href="https://developer.xero.com/app/manage" target="_blank" rel="noopener">Xero Developer Portal</a></li>
                <li>Open your app → <em>Configuration</em></li>
                <li>Add this <strong>exact</strong> Redirect URI:<br>
                  <code class="redirect-uri-box">http://127.0.0.1:3000/auth/xero/callback</code></li>
                <li>Save Client ID + Secret below, then click <em>Connect Xero</em></li>
              </ol>
              <p class="field-help">403 Forbidden usually means the Redirect URI above is missing or does not match exactly in Xero (127.0.0.1 vs localhost matters).</p>
            </div>`
          : "";

      const xeroBtn =
        type === "XERO"
          ? `<button type="button" class="btn primary xero-connect-btn" data-slug="${currentOrg.slug}">
              ${data.xeroStatus?.connected ? "Reconnect Xero" : "Connect Xero"}
            </button>
            ${data.xeroStatus?.connected ? `<span class="badge ok">Connected · ${esc(data.xeroStatus.tenantId || "")}</span>` : ""}`
          : "";

      return `<form class="card integration-card" data-integration="${type}">
        <h3>${labels[type]} <span class="badge ${status.cls}">${status.label}</span></h3>
        ${xeroSetup}
        ${fieldsHtml}
        <div class="integration-actions">
          <button type="submit" class="btn primary">Save ${labels[type]}</button>
          ${xeroBtn}
        </div>
      </form>`;
    })
    .join("");

  container.querySelectorAll("form[data-integration]").forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const type = form.dataset.integration;
      const body = {};
      form.querySelectorAll("input, select").forEach((el) => {
        if (el.type === "checkbox") {
          body[el.name] = el.checked;
        } else if (el.value !== "") {
          body[el.name] = el.type === "number" ? Number(el.value) : el.value;
        }
      });
      try {
        await api.saveIntegration(currentOrg.slug, type, body);
        showToast(`${type} integration saved`);
        await renderIntegrations();
      } catch (err) {
        showToast(err.message);
      }
    };
  });

  container.querySelectorAll(".xero-connect-btn").forEach((btn) => {
    btn.onclick = async () => {
      const xeroForm = container.querySelector('form[data-integration="XERO"]');
      const clientId = xeroForm?.querySelector('[name="clientId"]')?.value?.trim();
      const redirectUri = xeroForm?.querySelector('[name="redirectUri"]')?.value?.trim();

      if (!clientId) {
        showToast("Save Client ID in the Xero form first");
        return;
      }

      try {
        const result = await api.xeroConnect(btn.dataset.slug);

        if (result.redirectUri && result.redirectUri !== redirectUri) {
          showToast(`Using redirect URI: ${result.redirectUri}`);
        }

        // Same-tab redirect is more reliable than popups for OAuth
        window.location.href = result.authUrl;
      } catch (err) {
        showToast(err.message);
      }
    };
  });
}

function getIntegrationStatus(type, cfg, xeroStatus) {
  switch (type) {
    case "XERO":
      return xeroStatus?.connected
        ? { label: "Connected", cls: "ok" }
        : cfg.clientId
          ? { label: "Configured", cls: "warn" }
          : { label: "Not set", cls: "off" };
    case "WHATSAPP":
      return cfg.apiToken && cfg.phoneNumberId
        ? { label: "Configured", cls: "ok" }
        : { label: "Not set", cls: "off" };
    case "EMAIL":
      return cfg.imapHost && cfg.imapUser
        ? { label: "Configured", cls: "ok" }
        : { label: "Not set", cls: "off" };
    case "DBS":
      return cfg.orgId && cfg.userId
        ? { label: "Configured", cls: "ok" }
        : { label: "Not set", cls: "off" };
    default:
      return { label: "Optional", cls: "off" };
  }
}

async function renderWorkflows() {
  const workflows = await api.getWorkflows(currentOrg.slug);
  const el = document.getElementById("workflow-list");
  const rows = workflows
    .map(
      (w) => `<tr>
      <td><code>${w.type}</code></td>
      <td><span class="badge ${w.status === "COMPLETED" ? "ok" : "warn"}">${w.status}</span></td>
      <td>${esc(w.currentStep || "—")}</td>
      <td>${new Date(w.createdAt).toLocaleString()}</td>
    </tr>`
    )
    .join("");

  el.innerHTML = `<h3 style="padding:1rem 1rem 0">Recent workflows</h3>
    <table>
      <thead><tr><th>Type</th><th>Status</th><th>Step</th><th>Created</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">No workflows yet</td></tr>'}</tbody>
    </table>`;
}

function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
      tab.classList.add("active");
      document.getElementById(`tab-${tab.dataset.tab}`).classList.remove("hidden");
    };
  });
}

function initForms() {
  document.getElementById("create-org-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      name: fd.get("name"),
      slug: fd.get("slug"),
      timezone: fd.get("timezone") || "Asia/Singapore",
    };
    const supName = fd.get("supervisorName");
    const supPhone = fd.get("supervisorPhone");
    if (supName && supPhone) {
      body.supervisor = { name: supName, phoneNumber: supPhone };
    }
    try {
      const org = await api.createOrg(body);
      showToast(`Created ${org.name}`);
      location.hash = `#/org/${org.slug}`;
    } catch (err) {
      showToast(err.message);
    }
  };

  document.getElementById("edit-org-form").onsubmit = async (e) => {
    e.preventDefault();
    if (!currentOrg) return;
    try {
      await api.updateOrg(currentOrg.slug, {
        name: document.getElementById("edit-name").value,
        timezone: document.getElementById("edit-timezone").value,
        isActive: document.getElementById("edit-active").checked,
      });
      showToast("Organization updated");
      await renderOrg(currentOrg.slug);
    } catch (err) {
      showToast(err.message);
    }
  };

  document.getElementById("add-member-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.addTeamMember(currentOrg.slug, {
        name: fd.get("name"),
        phoneNumber: fd.get("phoneNumber"),
        role: fd.get("role"),
      });
      showToast("Team member added");
      currentOrg = await api.getOrg(currentOrg.slug);
      renderTeamTable();
      e.target.reset();
    } catch (err) {
      showToast(err.message);
    }
  };

  document.getElementById("add-supplier-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.addSupplier(currentOrg.slug, Object.fromEntries(fd.entries()));
      showToast("Supplier added");
      currentOrg = await api.getOrg(currentOrg.slug);
      renderSupplierTable();
      e.target.reset();
    } catch (err) {
      showToast(err.message);
    }
  };

  document.getElementById("edit-supplier-form").onsubmit = async (e) => {
    e.preventDefault();
    if (!currentOrg) return;

    const fd = new FormData(e.target);
    const supplierId = fd.get("id");
    const body = {
      name: fd.get("name"),
      emailDomain: fd.get("emailDomain") || null,
      xeroContactId: fd.get("xeroContactId") || null,
      whatsappGroupId: fd.get("whatsappGroupId") || null,
      dbsPayeeName: fd.get("dbsPayeeName") || null,
    };

    try {
      await api.updateSupplier(currentOrg.slug, supplierId, body);
      showToast("Supplier updated");
      closeEditSupplier();
      currentOrg = await api.getOrg(currentOrg.slug);
      renderSupplierTable();
    } catch (err) {
      showToast(err.message);
    }
  };

  document.getElementById("cancel-edit-supplier-btn")?.addEventListener("click", closeEditSupplier);

  document.getElementById("team-list")?.addEventListener("click", async (e) => {
    const btn = e.target.closest(".remove-member-btn");
    if (!btn || !currentOrg) return;

    const memberId = btn.dataset.id;
    const memberName = btn.dataset.name;
    const memberRole = btn.dataset.role;
    const roleLabel = memberRole === "SUPERVISOR" ? "supervisor" : "team member";
    if (!confirm(`Remove ${roleLabel} "${memberName}"?`)) return;

    btn.disabled = true;
    try {
      await api.removeTeamMember(currentOrg.slug, memberId);
      showToast(`${memberRole === "SUPERVISOR" ? "Supervisor" : "Team member"} removed`);
      currentOrg = await api.getOrg(currentOrg.slug);
      renderTeamTable();
    } catch (err) {
      showToast(err.message);
      btn.disabled = false;
    }
  });

  document.getElementById("supplier-list")?.addEventListener("click", async (e) => {
    const editBtn = e.target.closest(".edit-supplier-btn");
    if (editBtn) {
      openEditSupplier(editBtn.dataset.id);
      return;
    }

    const btn = e.target.closest(".remove-supplier-btn");
    if (!btn || !currentOrg) return;

    const supplierId = btn.dataset.id;
    const supplierName = btn.dataset.name;
    if (!confirm(`Remove supplier "${supplierName}"?`)) return;

    btn.disabled = true;
    try {
      await api.removeSupplier(currentOrg.slug, supplierId);
      showToast("Supplier removed");
      currentOrg = await api.getOrg(currentOrg.slug);
      renderSupplierTable();
    } catch (err) {
      showToast(err.message);
      btn.disabled = false;
    }
  });

  document.getElementById("test-po-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.testPoIntake(currentOrg.slug, fd.get("message"));
      showToast("PO intake test queued — check worker logs");
      await renderWorkflows();
    } catch (err) {
      showToast(err.message);
    }
  };

  document.getElementById("test-whatsapp-webhook-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const message = fd.get("message") || "- Bok choy: 10 kg\n- Zucchini: 40 kg";
    const btn = e.target.querySelector('button[type="submit"]');

    btn.disabled = true;
    try {
      const result = await api.testWhatsAppWebhook(currentOrg.slug, message);
      showToast(`Webhook ${result.status} — job queued (message ${result.messageId})`);
      await renderWorkflows();
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
    }
  };
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

async function route() {
  const hash = location.hash.slice(1) || "/";
  const parts = hash.split("/").filter(Boolean);

  document.querySelectorAll(".nav-link").forEach((l) => l.classList.remove("active"));

  if (parts[0] === "new") {
    document.querySelector('[data-route="new"]')?.classList.add("active");
    renderNew();
  } else if (parts[0] === "org" && parts[1]) {
    document.querySelector('[data-route="list"]')?.classList.add("active");
    await renderOrg(parts[1]);

    if (parts[2]) {
      const tab = parts[2];
      document.querySelectorAll(".tab").forEach((t) => {
        t.classList.toggle("active", t.dataset.tab === tab);
      });
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
      document.getElementById(`tab-${tab}`)?.classList.remove("hidden");
    }
  } else {
    document.querySelector('[data-route="list"]')?.classList.add("active");
    await renderList();
  }
}

window.addEventListener("hashchange", () => {
  if (api.getToken()) route();
});

initLogin();
initTabs();
initForms();

if (api.getToken()) {
  route();
}
