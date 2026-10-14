/* Utilitaires partages de la plateforme CAVALLY */
const Cav = (() => {
  const KEY = "cavally_user";

  function getUser() {
    return localStorage.getItem(KEY) || "";
  }
  function setUser(v) {
    localStorage.setItem(KEY, v || "");
  }

  async function api(url, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    headers["X-User"] = getUser() || "Anonyme";
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(Object.assign({ user: getUser() || "Anonyme" }, opts.json));
    }
    const res = await fetch(url, Object.assign({}, opts, { headers }));
    if (!res.ok) {
      let msg = res.status + " " + res.statusText;
      try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
      throw new Error(msg);
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : res.text();
  }

  let toastEl = null;
  function toast(msg, type = "") {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.className = "toast show " + type;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => (toastEl.className = "toast"), 2200);
  }

  function pct(v) {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : Math.round(n * 1000) / 10;
  }
  function fmtPct(v) {
    const p = pct(v);
    return (Number.isInteger(p) ? p : p.toFixed(1)) + " %";
  }

  // file d'enregistrement avec debounce
  function saver(onSaved) {
    let queue = new Map(); // clef -> update
    let timer = null;
    function push(key, update) {
      queue.set(key, update);
      clearTimeout(timer);
      timer = setTimeout(flush, 450);
    }
    async function flush() {
      if (!queue.size) return;
      const updates = Array.from(queue.values());
      queue = new Map();
      try {
        const r = await api("/api/save", { method: "POST", json: { updates } });
        if (onSaved) onSaved(r);
      } catch (e) {
        toast("Echec enregistrement : " + e.message, "err");
      }
    }
    return { push, flush };
  }

  function initUserField() {
    const el = document.getElementById("userName");
    if (!el) return;
    el.value = getUser();
    el.addEventListener("change", () => {
      setUser(el.value.trim());
      toast("Utilisateur : " + (el.value.trim() || "Anonyme"), "ok");
    });
  }

  // Menu de navigation (mobile)
  function initNav() {
    const btn = document.getElementById("navToggle");
    const nav = document.getElementById("mainNav");
    if (!btn || !nav) return;
    btn.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  // Bascule clair / sombre
  function initTheme() {
    const btn = document.getElementById("themeBtn");
    const root = document.documentElement;
    function icon() {
      if (btn) btn.textContent = root.getAttribute("data-theme") === "dark" ? "☀️" : "🌙";
    }
    icon();
    if (!btn) return;
    btn.addEventListener("click", () => {
      const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("cavally_theme", next); } catch (e) {}
      icon();
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  document.addEventListener("DOMContentLoaded", () => {
    initUserField();
    initNav();
    initTheme();
  });
  return { getUser, setUser, api, toast, pct, fmtPct, saver, esc };
})();
