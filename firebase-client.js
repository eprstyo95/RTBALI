(function () {
  "use strict";

  const DEFAULT_CONFIG_PATH = "firebase-config.json";
  const LOCAL_CONFIG_KEY = "rtbaliFirebaseConfig";
  const PRE_PULL_BACKUP_KEY = "rtbaliBeforeCloudPull";
  const DEFAULT_API_BASE = "https://asia-southeast2-rtbali.cloudfunctions.net/api";
  const DEFAULT_TRIP_ID = "rtbali";
  const AUTO_MERGE_INTERVAL_MS = 60 * 60 * 1000;

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  async function loadConfig() {
    const local = loadLocalConfig();
    if (local) return local;
    try {
      const response = await fetch(DEFAULT_CONFIG_PATH, { cache: "no-store" });
      if (!response.ok) return null;
      const config = await response.json();
      if (!config || !config.apiBase) return null;
      return {
        tripId: "rtbali",
        syncKey: "",
        ...config,
        apiBase: String(config.apiBase).replace(/\/$/, "")
      };
    } catch (_) {
      return null;
    }
  }

  function normalizeConfig(config) {
    if (!config || !config.apiBase || !config.syncKey) return null;
    return {
      tripId: DEFAULT_TRIP_ID,
      ...config,
      apiBase: String(config.apiBase).replace(/\/$/, ""),
      syncKey: String(config.syncKey).trim()
    };
  }

  function loadLocalConfig() {
    try {
      return normalizeConfig(JSON.parse(localStorage.getItem(LOCAL_CONFIG_KEY) || "null"));
    } catch (_) {
      return null;
    }
  }

  function saveLocalConfig(config) {
    localStorage.setItem(LOCAL_CONFIG_KEY, JSON.stringify(config));
  }

  function configFromUrl() {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    const query = new URLSearchParams(location.search);
    const get = (key) => hash.get(key) || query.get(key);
    const syncKey = get("sync") || get("syncKey") || get("key");
    if (!syncKey) return null;
    return normalizeConfig({
      apiBase: get("api") || DEFAULT_API_BASE,
      tripId: get("trip") || DEFAULT_TRIP_ID,
      syncKey
    });
  }

  function clearSetupUrl() {
    if (!history.replaceState) return;
    history.replaceState(null, document.title, location.pathname);
  }

  function setupLink(config = loadLocalConfig()) {
    if (!config) return "";
    const params = new URLSearchParams({
      api: config.apiBase,
      trip: config.tripId,
      sync: config.syncKey
    });
    return `${location.origin}${location.pathname}#${params.toString()}`;
  }

  function promptConfig(existing = {}) {
    const apiBase = prompt("Firebase API URL", existing.apiBase || DEFAULT_API_BASE);
    if (!apiBase) return null;
    const tripId = prompt("Trip ID", existing.tripId || DEFAULT_TRIP_ID);
    if (!tripId) return null;
    const syncKey = prompt("Firebase sync key");
    if (!syncKey) return null;
    return normalizeConfig({ apiBase, tripId, syncKey });
  }

  function button(label, className, onClick) {
    const btn = document.createElement("button");
    btn.className = className;
    btn.type = "button";
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function status(text) {
    const el = document.getElementById("firebaseSyncState");
    if (el) el.textContent = text;
  }

  async function request(config, path, options = {}) {
    const headers = {
      "content-type": "application/json",
      "x-rtbali-sync-key": config.syncKey || "",
      ...(options.headers || {})
    };
    const response = await fetch(`${config.apiBase}${path}`, { ...options, headers });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = { raw: text }; }
    if (!response.ok) throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
    return payload;
  }

  function hasFullDashboardDb(db) {
    return Boolean(
      db &&
      Array.isArray(db.tripPlans) && db.tripPlans.length &&
      Array.isArray(db.accommodations) &&
      Array.isArray(db.checklist) &&
      Array.isArray(db.categoryDetails)
    );
  }

  function backupBeforeCloudPull() {
    try {
      localStorage.setItem(PRE_PULL_BACKUP_KEY, JSON.stringify(window.RTBALI.getDb()));
    } catch (_) {}
  }

  async function pushDb(config) {
    status("Pushing...");
    const db = window.RTBALI.getDb();
    const payload = await request(config, `/import?tripId=${encodeURIComponent(config.tripId)}`, {
      method: "POST",
      body: JSON.stringify({ db })
    });
    const pruned = Number(payload?.prunedExpenses || 0);
    status(pruned ? `Pushed; pruned ${pruned} cloud expenses` : "Pushed to Firebase");
    window.RTBALI.toast(pruned ? `Pushed; removed ${pruned} cloud expenses` : "Pushed to Firebase");
  }

  async function pullDb(config) {
    status("Pulling...");
    const payload = await request(config, `/export?tripId=${encodeURIComponent(config.tripId)}`);
    if (!payload?.db) throw new Error("No database returned");
    backupBeforeCloudPull();
    if (hasFullDashboardDb(payload.db)) {
      window.RTBALI.replaceDb(payload.db, "Pulled full cloud database");
      status("Pulled full cloud database");
      return;
    }
    window.RTBALI.mergeExpenses(payload.db.expenses || [], "Cloud only had expenses; merged safely");
    status("Cloud only had expenses, so I merged instead of replacing");
  }

  async function mergeExpenses(config) {
    status("Merging expenses...");
    const payload = await request(config, `/expenses?tripId=${encodeURIComponent(config.tripId)}`);
    window.RTBALI.mergeExpenses(payload.expenses || [], "Merged Firebase expenses");
    status(`Merged ${(payload.expenses || []).length} cloud expenses`);
  }

  async function deleteExpense(config, expenseId) {
    if (!expenseId) throw new Error("Missing expense id");
    status("Deleting cloud expense...");
    await request(config, `/expense/delete?tripId=${encodeURIComponent(config.tripId)}&id=${encodeURIComponent(expenseId)}`, {
      method: "POST",
      body: JSON.stringify({ id: expenseId })
    });
    status("Cloud expense deleted");
  }

  async function autoMergeExpenses(config) {
    try {
      const payload = await request(config, `/expenses?tripId=${encodeURIComponent(config.tripId)}`);
      window.RTBALI.mergeExpenses(payload.expenses || [], "Synced Telegram expenses");
      status(`Auto-synced ${(payload.expenses || []).length} cloud expenses`);
    } catch (err) {
      status(`Cloud sync failed: ${err.message}`);
    }
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Could not read file"));
      reader.readAsDataURL(file);
    });
  }

  async function uploadReceipt(config, file) {
    status("OCR running...");
    const dataUrl = await readFileAsDataUrl(file);
    const payload = await request(config, `/receipt?tripId=${encodeURIComponent(config.tripId)}`, {
      method: "POST",
      body: JSON.stringify({ dataUrl, mimeType: file.type || "image/jpeg", fileName: file.name })
    });
    if (payload.expense) window.RTBALI.mergeExpenses([payload.expense], "OCR draft merged");
    status(payload.ocrText ? "OCR draft saved" : "Receipt draft saved, no text found");
  }

  function installControls(config) {
    const topActions = document.querySelector("header .top-actions");
    if (!topActions) return;

    const wrap = document.createElement("span");
    wrap.className = "sync-pill";
    wrap.id = "firebaseSyncState";
    wrap.textContent = "Firebase ready";
    topActions.insertBefore(wrap, topActions.firstChild);

    topActions.appendChild(button("Pull cloud", "btn ghost", () => pullDb(config).catch((err) => status(err.message))));
    topActions.appendChild(button("Merge expenses", "btn ghost", () => mergeExpenses(config).catch((err) => status(err.message))));
    const file = document.createElement("input");
    file.type = "file";
    file.accept = "image/*";
    file.capture = "environment";
    file.style.display = "none";
    file.addEventListener("change", () => {
      const selected = file.files && file.files[0];
      if (selected) uploadReceipt(config, selected).catch((err) => status(err.message));
      file.value = "";
    });
    topActions.appendChild(file);
    topActions.appendChild(button("OCR receipt", "btn ghost", () => file.click()));
    topActions.appendChild(button("Push cloud", "btn ghost", () => pushDb(config).catch((err) => status(err.message))));
    topActions.appendChild(button("Cloud setup", "btn ghost", () => {
      const next = promptConfig(config);
      if (!next) return;
      saveLocalConfig(next);
      window.location.reload();
    }));
    topActions.appendChild(button("Copy setup link", "btn ghost", async () => {
      const link = setupLink(config);
      try {
        await navigator.clipboard.writeText(link);
        status("Setup link copied");
      } catch (_) {
        prompt("Copy setup link", link);
      }
    }));

    window.RTBALICloud = {
      pushDb: () => pushDb(config),
      pullDb: () => pullDb(config),
      mergeExpenses: () => mergeExpenses(config),
      deleteExpense: (expenseId) => deleteExpense(config, expenseId)
    };

    if (window.RTBALI?.toast) window.RTBALI.toast("Cloud quick actions ready");

    autoMergeExpenses(config);
    setInterval(() => autoMergeExpenses(config), AUTO_MERGE_INTERVAL_MS);
  }

  function installSetupOnly() {
    const topActions = document.querySelector("header .top-actions");
    if (!topActions) return;

    const wrap = document.createElement("span");
    wrap.className = "sync-pill";
    wrap.id = "firebaseSyncState";
    wrap.textContent = "Cloud not set";
    topActions.insertBefore(wrap, topActions.firstChild);

    topActions.appendChild(button("Cloud setup", "btn ghost", () => {
      const config = promptConfig();
      if (!config) return;
      saveLocalConfig(config);
      window.location.reload();
    }));
  }

  ready(async () => {
    if (!window.RTBALI) return;
    const urlConfig = configFromUrl();
    if (urlConfig) {
      saveLocalConfig(urlConfig);
      clearSetupUrl();
      window.RTBALI.toast("Cloud setup saved");
    }
    const config = await loadConfig();
    if (!config) {
      installSetupOnly();
      return;
    }
    installControls(config);
  });
})();
