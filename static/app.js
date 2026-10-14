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

  /* -- File d'enregistrement persistante (mode hors-ligne) ----------------- */
  const QUEUE_KEY = "cavally_queue";
  const _savedCbs = [];
  let SEQ = 0;

  function loadQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "{}") || {}; }
    catch (e) { return {}; }
  }
  function saveQueue(q) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) {}
  }
  function pending() {
    return Object.keys(loadQueue()).length;
  }

  // Indicateur de connexion (en ligne / hors ligne / synchronisation)
  function updateNetUI() {
    const n = pending();
    const dot = document.getElementById("netStatus");
    const bar = document.getElementById("offlineBar");
    const online = navigator.onLine;
    if (dot) {
      if (!online) { dot.className = "netstatus off"; dot.textContent = n ? "hors ligne · " + n : "hors ligne"; }
      else if (n) { dot.className = "netstatus sync"; dot.textContent = "sync · " + n; }
      else { dot.className = "netstatus on"; dot.textContent = "en ligne"; }
      dot.title = !online
        ? "Hors ligne — " + n + " saisie(s) en attente de synchronisation"
        : (n ? "Synchronisation vers le serveur…" : "Connecté au serveur");
    }
    if (bar) bar.hidden = online;
  }

  function enqueue(key, update) {
    const q = loadQueue();
    q[key] = { seq: ++SEQ, u: update };
    saveQueue(q);
    updateNetUI();
  }

  // Envoie la file au serveur ; conserve les entrées si le réseau manque.
  async function flushQueue() {
    const q = loadQueue();
    const keys = Object.keys(q);
    updateNetUI();
    if (!keys.length || !navigator.onLine) return;
    const sent = keys.map((k) => ({ k, seq: q[k].seq, u: q[k].u }));
    try {
      const r = await api("/api/save", { method: "POST", json: { updates: sent.map((s) => s.u) } });
      const q2 = loadQueue();
      sent.forEach((s) => { if (q2[s.k] && q2[s.k].seq === s.seq) delete q2[s.k]; });
      saveQueue(q2);
      _savedCbs.forEach((cb) => { try { cb(r); } catch (e) {} });
      if (sent.length > 1) toast("Synchronisé (" + sent.length + ")", "ok");
    } catch (e) {
      // réseau toujours absent : la file est conservée pour un nouvel essai
    }
    updateNetUI();
  }

  // file d'enregistrement avec debounce + persistance locale (hors-ligne)
  function saver(onSaved) {
    if (onSaved) _savedCbs.push(onSaved);
    let timer = null;
    function push(key, update) {
      enqueue(key, update);
      clearTimeout(timer);
      timer = setTimeout(flushQueue, 450);
    }
    return { push, flush: flushQueue };
  }

  function initNet() {
    updateNetUI();
    window.addEventListener("online", () => { updateNetUI(); flushQueue(); });
    window.addEventListener("offline", updateNetUI);
    setInterval(flushQueue, 15000);           // nouvel essai périodique
    window.addEventListener("focus", flushQueue);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) flushQueue(); });
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
    initNet();
  });
  return { getUser, setUser, api, toast, pct, fmtPct, saver, esc, pending, flush: flushQueue };
})();
