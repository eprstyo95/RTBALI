(function () {
  "use strict";

  const DEFAULT_CONFIG_PATH = "firebase-config.json";

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  async function loadConfig() {
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

  async function pushDb(config) {
    status("Pushing...");
    const db = window.RTBALI.getDb();
    await request(config, `/import?tripId=${encodeURIComponent(config.tripId)}`, {
      method: "POST",
      body: JSON.stringify({ db })
    });
    status("Pushed to Firebase");
    window.RTBALI.toast("Pushed to Firebase");
  }

  async function pullDb(config) {
    status("Pulling...");
    const payload = await request(config, `/export?tripId=${encodeURIComponent(config.tripId)}`);
    if (!payload?.db) throw new Error("No database returned");
    window.RTBALI.replaceDb(payload.db, "Pulled from Firebase");
    status("Pulled from Firebase");
  }

  async function mergeExpenses(config) {
    status("Merging expenses...");
    const payload = await request(config, `/expenses?tripId=${encodeURIComponent(config.tripId)}`);
    window.RTBALI.mergeExpenses(payload.expenses || [], "Merged Firebase expenses");
    status(`Merged ${(payload.expenses || []).length} cloud expenses`);
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
  }

  ready(async () => {
    if (!window.RTBALI) return;
    const config = await loadConfig();
    if (!config) return;
    installControls(config);
  });
})();
