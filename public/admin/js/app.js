let currentOrg = null;
let integrationSchemas = null;
let selectedSkuSupplierId = "";
let selectedSupplierChatId = "";
let chatPollTimer = null;
let lastChatSignature = "";

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 4000);
}

async function uploadInvoiceFiles(fileList) {
  if (!currentOrg) throw new Error("Open an organisation first");
  const files = Array.from(fileList || []).filter((file) => file && file.size);
  if (!files.length) throw new Error("Choose an invoice photo or PDF");
  for (const file of files) {
    if (file.size > 12 * 1024 * 1024) throw new Error(`${file.name} is larger than 12 MB`);
  }
  const result = await api.testInvoice(currentOrg.slug, files);
  await renderWorkflows();
  await refreshConversations(true);
  return result;
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
  renderSkuPanel();
    await renderIntegrations();
    await renderWorkflows();
    await renderOpenPos();
    fillEmailInvoiceFrom();
    document.getElementById("load-xero-contacts-btn")?.addEventListener("click", loadXeroContacts);
    if (!document.getElementById("tab-activity").classList.contains("hidden")) {
      startChatPolling();
    } else {
      lastChatSignature = "";
    }
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
      <td>${s.skuMappings?.length ?? 0}</td>
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
    <thead><tr><th>Name</th><th>Xero Contact ID</th><th>Email domain</th><th>WA Group</th><th>DBS Payee</th><th>SKUs</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" class="muted">No suppliers</td></tr>'}</tbody>
  </table>`;
}

function currentSkuSupplier() {
  return currentOrg?.suppliers.find((s) => s.id === selectedSkuSupplierId) ?? currentOrg?.suppliers[0] ?? null;
}

function renderSkuPanel() {
  const select = document.getElementById("sku-supplier-select");
  const list = document.getElementById("sku-mapping-list");
  if (!select || !list || !currentOrg) return;

  if (!currentOrg.suppliers.some((s) => s.id === selectedSkuSupplierId)) {
    selectedSkuSupplierId = currentOrg.suppliers[0]?.id || "";
  }

  select.innerHTML = currentOrg.suppliers.length
    ? currentOrg.suppliers
        .map(
          (s) =>
            `<option value="${esc(s.id)}" ${s.id === selectedSkuSupplierId ? "selected" : ""}>${esc(s.name)}</option>`
        )
        .join("")
    : `<option value="">No suppliers</option>`;

  const supplier = currentSkuSupplier();
  const mappings = supplier?.skuMappings ?? [];
  const rows = mappings
    .map(
      (m) => `<tr>
      <td>${esc(m.supplierItemName)}</td>
      <td><code>${esc(m.xeroItemCode || m.xeroItemId)}</code></td>
      <td class="muted">${esc(m.confirmedBy || "—")}</td>
      <td class="actions-cell">
        <button type="button" class="btn sm danger remove-sku-btn" data-id="${esc(m.id)}" data-name="${esc(m.supplierItemName)}">
          Remove
        </button>
      </td>
    </tr>`
    )
    .join("");

  list.innerHTML = `<table>
    <thead><tr><th>PO item name</th><th>Xero item</th><th>Set by</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="muted">No SKU mappings for this supplier</td></tr>'}</tbody>
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

async function refreshSuppliers() {
  if (!currentOrg) return;
  currentOrg = await api.getOrg(currentOrg.slug);
  renderSupplierTable();
  renderSkuPanel();
}

async function importXeroSuppliers(contactIds) {
  if (!currentOrg) return;
  const result = await api.importXeroSuppliers(currentOrg.slug, contactIds);
  const parts = [];
  if (result.created) parts.push(`${result.created} added`);
  if (result.updated) parts.push(`${result.updated} updated`);
  showToast(parts.length ? `Imported from Xero: ${parts.join(", ")}` : "No Xero suppliers to import");
  await refreshSuppliers();
  return result;
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
        <td class="actions-cell">
          <button type="button" class="btn sm import-xero-contact-btn" data-id="${esc(c.contactId)}" data-name="${esc(c.name)}">
            Import
          </button>
        </td>
      </tr>`
      )
      .join("");

    el.innerHTML = `<table>
      <thead><tr><th>Name in Xero</th><th>Contact ID (click to copy)</th><th>Email</th><th></th></tr></thead>
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
  const waOnboarding = await api.getWhatsAppOnboarding(currentOrg.slug).catch(() => null);
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

      const waOnboardingBox =
        type === "WHATSAPP" ? renderWhatsAppOnboardingBox(cfg, waOnboarding) : "";

      return `<form class="card integration-card" data-integration="${type}">
        <h3>${labels[type]} <span class="badge ${status.cls}">${status.label}</span></h3>
        ${xeroSetup}
        ${waOnboardingBox}
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

  container.querySelectorAll(".wa-onboarding-link-btn").forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "Generating…";
      try {
        const result = await api.generateWhatsAppOnboardingLink(currentOrg.slug);
        await navigator.clipboard.writeText(result.url).catch(() => {});
        showToast("Onboarding link generated and copied to clipboard");
        await renderIntegrations();
      } catch (err) {
        showToast(err.message);
        btn.disabled = false;
        btn.textContent = "Generate onboarding link";
      }
    };
  });

  container.querySelectorAll(".wa-onboarding-url").forEach((el) => {
    el.style.cursor = "pointer";
    el.onclick = () => {
      navigator.clipboard.writeText(el.textContent);
      showToast("Onboarding link copied — send it to the tenant");
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

function renderWhatsAppOnboardingBox(cfg, waOnboarding) {
  const connectedBanner =
    cfg.onboardedVia === "embedded_signup"
      ? `<p class="field-help" style="margin-bottom:.5rem">
          <span class="badge ok">Partner-connected</span>
          Tenant authorized via Embedded Signup${cfg.displayPhoneNumber ? ` · ${esc(cfg.displayPhoneNumber)}` : ""}${cfg.onboardedAt ? ` · ${new Date(cfg.onboardedAt).toLocaleDateString()}` : ""}
        </p>`
      : "";

  if (!waOnboarding) {
    return `<div class="xero-setup-box">${connectedBanner}
      <p class="field-help">Could not load onboarding status.</p>
    </div>`;
  }

  if (!waOnboarding.partnerConfigured) {
    return `<div class="xero-setup-box">${connectedBanner}
      <strong>Tenant onboarding (Embedded Signup)</strong>
      <p class="field-help">
        Set <code>META_APP_ID</code>, <code>META_APP_SECRET</code>, and <code>META_CONFIG_ID</code>
        in <code>.env</code> to enable one-click tenant onboarding. Until then, credentials can be
        entered manually below.
      </p>
    </div>`;
  }

  const pendingHtml = waOnboarding.pendingLink
    ? `<p class="field-help">Active link (click to copy, expires ${new Date(waOnboarding.pendingLink.expiresAt).toLocaleString()}):</p>
       <code class="redirect-uri-box wa-onboarding-url" title="Click to copy">${esc(waOnboarding.pendingLink.url)}</code>`
    : "";

  const sessionRows = (waOnboarding.sessions || [])
    .slice(0, 3)
    .map((s) => {
      const cls = s.status === "COMPLETED" ? "ok" : s.status === "PENDING" ? "warn" : "off";
      const detail =
        s.status === "COMPLETED"
          ? `WABA ${s.wabaId || "—"}`
          : s.status === "FAILED"
            ? esc(s.error || "failed")
            : `expires ${new Date(s.expiresAt).toLocaleDateString()}`;
      return `<li style="padding:.2rem 0">
        <span class="badge ${cls}">${s.status}</span>
        <span class="field-help" style="display:inline">${detail} · ${new Date(s.createdAt).toLocaleString()}</span>
      </li>`;
    })
    .join("");

  return `<div class="xero-setup-box">${connectedBanner}
    <strong>Tenant onboarding (Embedded Signup)</strong>
    <p class="field-help" style="margin:.35rem 0 .6rem">
      Generate a link and send it to the tenant. They log in with Facebook, pick their
      WhatsApp Business account, and authorize this app as a partner — credentials below
      are then filled automatically.
    </p>
    <button type="button" class="btn sm primary wa-onboarding-link-btn">Generate onboarding link</button>
    ${pendingHtml}
    ${sessionRows ? `<ul style="list-style:none;margin-top:.6rem">${sessionRows}</ul>` : ""}
  </div>`;
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
      if (cfg.onboardedVia === "embedded_signup") {
        return { label: "Connected (partner)", cls: "ok" };
      }
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
      <td><span class="badge ${w.status === "COMPLETED" ? "ok" : w.status === "FAILED" ? "off" : "warn"}">${w.status}</span></td>
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

function money(value) {
  if (value == null || value === "") return "—";
  const amount = Number(value);
  if (Number.isNaN(amount)) return String(value);
  return `S$${amount.toFixed(2)}`;
}

async function renderOpenPos() {
  const el = document.getElementById("open-po-list");
  if (!el || !currentOrg) return;
  try {
    const orders = await api.getPurchaseOrders(currentOrg.slug);
    if (!orders.length) {
      el.innerHTML = `<p class="muted">No open POs. You can still upload — the bot will ask whether to create a PO from the invoice.</p>`;
      return;
    }
    const rows = orders
      .map((po) => {
        const lines = (po.lines || [])
          .map((line) => `${line.itemName} × ${line.quantity}${line.unit ? ` ${line.unit}` : ""}`)
          .join(", ");
        return `<tr>
          <td>${esc(po.supplier?.name || "—")}</td>
          <td><code>${esc(po.xeroPoNumber || po.id)}</code></td>
          <td>${esc(po.status)}</td>
          <td>${new Date(po.createdAt).toLocaleDateString()}</td>
          <td>${money(po.totalAmount)}</td>
          <td class="po-lines">${esc(lines || "—")}</td>
        </tr>`;
      })
      .join("");
    el.innerHTML = `<table>
      <thead><tr><th>Supplier</th><th>PO</th><th>Status</th><th>Date</th><th>Total</th><th>Lines</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } catch (err) {
    el.innerHTML = `<p class="muted">Could not load POs: ${esc(err.message)}</p>`;
  }
}

function fillEmailInvoiceFrom() {
  const input = document.getElementById("email-invoice-from");
  if (!input || input.value.trim()) return;
  const supplier = currentOrg?.suppliers?.find((s) => s.emailDomain);
  if (supplier?.emailDomain) input.placeholder = `ap@${supplier.emailDomain}`;
}

function stopChatPolling() {
  if (chatPollTimer) {
    clearInterval(chatPollTimer);
    chatPollTimer = null;
  }
}

function startChatPolling() {
  stopChatPolling();
  refreshConversations();
  chatPollTimer = setInterval(() => {
    if (document.getElementById("tab-activity")?.classList.contains("hidden")) return;
    refreshConversations();
    renderWorkflows();
  }, 2000);
}

function chatSignature(data) {
  const last = data.messages?.[data.messages.length - 1];
  return `${data.messages?.length ?? 0}:${last?.id ?? ""}:${data.supervisorPhone ?? ""}:${(data.suppliers || []).map((s) => s.id).join(",")}`;
}

function formatChatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function renderChatLog(el, messages, emptyText) {
  if (!el) return;

  if (!messages.length) {
    el.innerHTML = `<div class="chat-empty">${esc(emptyText)}</div>`;
    return;
  }

  el.innerHTML = messages
    .map((m) => {
      const isOut = m.direction === "outbound" || m.sender === "bot";
      const who = isOut
        ? "Bot"
        : m.sender === "supplier"
          ? m.supplierName || "Supplier"
          : "You (supervisor)";
      return `<div class="chat-bubble ${isOut ? "out" : "in"}">
        <span class="chat-meta">${esc(who)} · ${esc(formatChatTime(m.createdAt))}</span>
        ${esc(m.text)}
      </div>`;
    })
    .join("");

  el.scrollTop = el.scrollHeight;
}

async function refreshConversations(force = false) {
  if (!currentOrg) return;
  const supervisorLog = document.getElementById("supervisor-chat-log");
  const supplierLog = document.getElementById("supplier-chat-log");
  if (!supervisorLog || !supplierLog) return;

  try {
    const data = await api.getConversations(currentOrg.slug);
    const signature = chatSignature(data);
    if (!force && signature === lastChatSignature) return;

    const prevSignature = lastChatSignature;
    lastChatSignature = signature;

    const meta = document.getElementById("supervisor-chat-meta");
    if (meta) {
      meta.textContent = data.supervisorName
        ? `${data.supervisorName} · ${data.supervisorPhone || ""}`
        : data.supervisorPhone || "No supervisor";
    }

    const select = document.getElementById("supplier-chat-select");
    const suppliers = data.suppliers || [];
    if (select) {
      if (!suppliers.some((s) => s.id === selectedSupplierChatId)) {
        selectedSupplierChatId = suppliers[0]?.id || "";
      }
      select.innerHTML = suppliers.length
        ? suppliers
            .map(
              (s) =>
                `<option value="${esc(s.id)}" ${s.id === selectedSupplierChatId ? "selected" : ""}>${esc(s.name)}</option>`
            )
            .join("")
        : `<option value="">No suppliers</option>`;
    }

    const supervisorMsgs = (data.messages || []).filter((m) => m.channel === "SUPERVISOR");
    const supplierMsgs = (data.messages || []).filter((m) => {
      if (m.channel !== "SUPPLIER") return false;
      if (!selectedSupplierChatId) return true;
      return !m.supplierId || m.supplierId === selectedSupplierChatId;
    });

    renderChatLog(
      supervisorLog,
      supervisorMsgs,
      "This is your private chat with the bot. Send an order like “Beetroot 2 kg”."
    );
    renderChatLog(
      supplierLog,
      supplierMsgs,
      "Empty until the bot posts a confirmed PO for this supplier. Then reply here as the supplier."
    );

    if (prevSignature && prevSignature !== signature) {
      renderWorkflows().catch(() => {});
    }
  } catch {
    /* keep last rendered chat if polling fails */
  }
}

function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
      tab.classList.add("active");
      document.getElementById(`tab-${tab.dataset.tab}`).classList.remove("hidden");
      if (tab.dataset.tab === "activity") startChatPolling();
      else stopChatPolling();
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
      await refreshSuppliers();
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
      await refreshSuppliers();
    } catch (err) {
      showToast(err.message);
    }
  };

  document.getElementById("cancel-edit-supplier-btn")?.addEventListener("click", closeEditSupplier);

  document.getElementById("import-xero-suppliers-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("import-xero-suppliers-btn");
    if (!currentOrg || !btn) return;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Importing…";
    try {
      await importXeroSuppliers();
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  document.getElementById("xero-contacts-list")?.addEventListener("click", async (e) => {
    const btn = e.target.closest(".import-xero-contact-btn");
    if (!btn || !currentOrg) return;
    btn.disabled = true;
    try {
      await importXeroSuppliers([btn.dataset.id]);
    } catch (err) {
      showToast(err.message);
      btn.disabled = false;
    }
  });

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
      await refreshSuppliers();
    } catch (err) {
      showToast(err.message);
      btn.disabled = false;
    }
  });

  document.getElementById("sku-supplier-select")?.addEventListener("change", (e) => {
    selectedSkuSupplierId = e.target.value;
    renderSkuPanel();
  });

  document.getElementById("add-sku-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const supplier = currentSkuSupplier();
    if (!currentOrg || !supplier) {
      showToast("Add a supplier first");
      return;
    }

    const fd = new FormData(e.target);
    const itemSelect = document.getElementById("sku-xero-item-select");
    const selectedOption = itemSelect?.selectedOptions?.[0];
    const xeroItemId = selectedOption?.value || "";
    const xeroItemCode =
      selectedOption?.dataset.code || fd.get("xeroItemCode") || xeroItemId;

    if (!fd.get("supplierItemName") || !xeroItemCode) {
      showToast("Item name and Xero item code are required");
      return;
    }

    try {
      await api.addSkuMapping(currentOrg.slug, supplier.id, {
        supplierItemName: fd.get("supplierItemName"),
        xeroItemId: xeroItemId || xeroItemCode,
        xeroItemCode,
      });
      showToast(`Mapped "${fd.get("supplierItemName")}" for ${supplier.name}`);
      e.target.reset();
      if (itemSelect) itemSelect.selectedIndex = 0;
      currentOrg = await api.getOrg(currentOrg.slug);
      renderSupplierTable();
      renderSkuPanel();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("load-xero-items-btn")?.addEventListener("click", async () => {
    const select = document.getElementById("sku-xero-item-select");
    const btn = document.getElementById("load-xero-items-btn");
    if (!currentOrg || !select || !btn) return;
    btn.disabled = true;
    try {
      const { items } = await api.listXeroItems(currentOrg.slug);
      if (!items?.length) {
        select.innerHTML = `<option value="">No items in Xero</option>`;
        showToast("No Xero items found");
        return;
      }
      select.innerHTML =
        `<option value="">Select a Xero item</option>` +
        items
          .map(
            (item) =>
              `<option value="${esc(item.itemId)}" data-code="${esc(item.code)}">${esc(item.code)} — ${esc(item.name)}</option>`
          )
          .join("");
      showToast(`Loaded ${items.length} Xero item(s)`);
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("sku-mapping-list")?.addEventListener("click", async (e) => {
    const btn = e.target.closest(".remove-sku-btn");
    const supplier = currentSkuSupplier();
    if (!btn || !currentOrg || !supplier) return;
    if (!confirm(`Remove SKU mapping "${btn.dataset.name}"?`)) return;
    btn.disabled = true;
    try {
      await api.removeSkuMapping(currentOrg.slug, supplier.id, btn.dataset.id);
      showToast("SKU mapping removed");
      currentOrg = await api.getOrg(currentOrg.slug);
      renderSupplierTable();
      renderSkuPanel();
    } catch (err) {
      showToast(err.message);
      btn.disabled = false;
    }
  });

  document.getElementById("reset-operational-btn")?.addEventListener("click", async () => {
    if (!currentOrg) return;
    if (
      !confirm(
        "Delete all purchase orders, SKU mappings, bills, invoices, and workflow runs for this organisation? Suppliers and integrations stay."
      )
    ) {
      return;
    }
    const btn = document.getElementById("reset-operational-btn");
    btn.disabled = true;
    try {
      const result = await api.resetOperational(currentOrg.slug);
      const deleted = result.deleted || {};
      showToast(
        `Reset: ${deleted.purchaseOrders ?? 0} POs, ${deleted.skuMappings ?? 0} SKUs, ${deleted.workflowRuns ?? 0} workflows`
      );
      currentOrg = await api.getOrg(currentOrg.slug);
      renderSupplierTable();
      renderSkuPanel();
      await renderWorkflows();
      await renderOpenPos();
      lastChatSignature = "";
      await refreshConversations(true);
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("test-po-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.testPoIntake(currentOrg.slug, fd.get("message"));
      showToast("PO intake test queued — watch the Supervisor chat");
      await renderWorkflows();
      await refreshConversations(true);
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
      showToast(`Webhook ${result.status} — watch the Supervisor chat`);
      await renderWorkflows();
      await refreshConversations(true);
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
    }
  };

  document.getElementById("test-group-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const result = await api.testWhatsAppWebhook(currentOrg.slug, fd.get("message") || "@bot remove zucchini", {
        isGroup: true,
        groupId: fd.get("groupId") || currentOrg.suppliers?.[0]?.whatsappGroupId || "test-group",
      });
      showToast(`Group webhook ${result.status}`);
      await renderWorkflows();
      await refreshConversations(true);
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("test-invoice-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = e.target.querySelector('input[type="file"]');
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      showToast("Reading invoice — PDFs can take up to a minute");
      await uploadInvoiceFiles(input?.files);
      showToast("Invoice processed — check Supervisor chat");
      e.target.reset();
    } catch (err) {
      showToast(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.querySelector('#test-invoice-form input[type="file"]')?.addEventListener("change", async (e) => {
    if (!e.target.files?.length) return;
    const btn = document.querySelector('#test-invoice-form button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      showToast("Reading invoice — PDFs can take up to a minute");
      await uploadInvoiceFiles(e.target.files);
      showToast("Invoice processed — check Supervisor chat");
      e.target.value = "";
    } catch (err) {
      showToast(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById("test-email-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      const files = Array.from(e.target.querySelector('input[type="file"]')?.files || []).filter(
        (file) => file && file.size
      );
      if (!files.length) throw new Error("Choose an invoice photo or PDF");
      const filename = files[0]?.name || "";
      const result = await api.testEmailScan(currentOrg.slug, {
        files,
        from: fd.get("from") || undefined,
        subject: fd.get("subject") || filename || "Invoice",
        kind: /soa|statement/i.test(`${fd.get("subject") || ""} ${filename}`) ? "soa" : "invoice",
      });
      showToast(`Email scan queued (${result.attachments} file${result.attachments === 1 ? "" : "s"})`);
      e.target.reset();
      fillEmailInvoiceFrom();
      await renderWorkflows();
      await refreshConversations(true);
    } catch (err) {
      showToast(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById("scan-live-inbox")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (!currentOrg) return;
    btn.disabled = true;
    try {
      showToast("Scanning live IMAP inbox…");
      const result = await api.scanLiveInbox(currentOrg.slug);
      const skipped = (result.skipped || []).length;
      showToast(
        `Inbox ${result.mailbox || ""}: ${result.attachments || 0} attachment(s), ${result.invoices || 0} invoice(s), ${result.soa || 0} SOA, ${skipped} skipped`
      );
      await renderWorkflows();
      await refreshConversations(true);
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("test-reconcile-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.testReconcile(currentOrg.slug, fd.get("message") || "Please reconcile payment for Fresh Farms");
      showToast("Reconciliation started");
      await renderWorkflows();
      await refreshConversations(true);
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("test-dbs-approve-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const result = await api.testDbsApprove(currentOrg.slug, fd.get("transactionRef") || undefined);
      showToast(`Simulated DBS approval ${result.transactionRef}`);
      await renderWorkflows();
      await refreshConversations(true);
    } catch (err) {
      showToast(err.message);
    }
  });

  async function sendChatReply(channel, form) {
    if (!currentOrg) return;
    const fd = new FormData(form);
    const message = String(fd.get("message") || "").trim();
    const fileInput = form.querySelector('input[type="file"]');
    const attached = fileInput?.files?.[0];
    if (!message && !attached) return;
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      if (attached) {
        showToast("Reading invoice — PDFs can take up to a minute");
        await uploadInvoiceFiles([attached]);
        showToast("Invoice processed — check this chat");
      } else {
        await api.replyConversation(currentOrg.slug, {
          channel,
          message,
          supplierId: channel === "supplier" ? selectedSupplierChatId : undefined,
        });
      }
      form.reset();
      fileInput?.closest(".chat-file-btn")?.classList.remove("has-file");
      await refreshConversations(true);
      await renderWorkflows();
    } catch (err) {
      showToast(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  document.getElementById("supervisor-chat-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    await sendChatReply("supervisor", e.target);
  });

  document.getElementById("supervisor-chat-form")?.querySelector('input[type="file"]')?.addEventListener("change", async (e) => {
    const input = e.target;
    input.closest(".chat-file-btn")?.classList.toggle("has-file", Boolean(input.files?.[0]));
    if (!input.files?.[0]) return;
    const btn = document.querySelector('#supervisor-chat-form button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      showToast("Reading invoice — PDFs can take up to a minute");
      await uploadInvoiceFiles(input.files);
      showToast("Invoice processed — check this chat");
      input.value = "";
      input.closest(".chat-file-btn")?.classList.remove("has-file");
    } catch (err) {
      showToast(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById("supplier-chat-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    await sendChatReply("supplier", e.target);
  });

  document.getElementById("supplier-chat-select")?.addEventListener("change", (e) => {
    selectedSupplierChatId = e.target.value;
    lastChatSignature = "";
    refreshConversations(true);
  });

  document.getElementById("clear-chats-btn")?.addEventListener("click", async () => {
    if (!currentOrg) return;
    if (!confirm("Clear supervisor and supplier chat history for this organisation?")) return;
    try {
      await api.clearConversations(currentOrg.slug);
      lastChatSignature = "";
      await refreshConversations(true);
      showToast("Chats cleared");
    } catch (err) {
      showToast(err.message);
    }
  });
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
    stopChatPolling();
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
      if (tab === "activity") startChatPolling();
      else stopChatPolling();
    }
  } else {
    stopChatPolling();
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
