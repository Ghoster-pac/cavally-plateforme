/* ===========================================================================
   CAVALLY — application autonome (Android / iOS / Windows)
   Données stockées sur l'appareil + sauvegarde en ligne (Supabase).
   Import / export Excel faits directement sur l'appareil.
   =========================================================================== */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- Config */
  const SUPABASE_URL = "https://bwizsitdyijrezqlixdp.supabase.co";
  const SUPABASE_KEY = "sb_publishable_U3apjfW4YOFZC4P6iCbZ7A_ef4kO3jM";
  const PAGE = 1000;
  const BATCH = 500;
  const BREAKER_MS = 60000;

  const STATUSES = ["Non démarré", "En cours", "Terminé", "Bloqué", "Non conforme", "À vérifier"];
  const STATUS_COLOR = {
    "Terminé": "#16a34a", "En cours": "#2563eb", "Bloqué": "#dc2626",
    "Non conforme": "#d97706", "À vérifier": "#7c3aed", "Non démarré": "#94a3b8",
  };

  const LS = {
    entries: "cavally.entries", meta: "cavally.meta", custom: "cavally.custom",
    deleted: "cavally.deleted", user: "cavally.user", queue: "cavally.cloudq",
    states: "cavally.cloudstate", edits: "cavally.edits", theme: "cavally_theme",
  };

  /* ------------------------------------------------------------- Storage */
  let ENTRIES = {};   // "lot|row|task|field" -> value (string)
  let META = {};      // same key -> {u, t}
  let CUSTOM = {};    // lot -> { row: {designation, niveau, created_by, created_at} }
  let DELETED = {};   // lot -> { row: {deleted_by, deleted_at} }
  let EDITS = [];     // journal local (activité récente)

  function lsGet(k, def) {
    try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); }
    catch (e) { return def; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast("Stockage plein ?", "err"); } }

  function loadStorage() {
    ENTRIES = lsGet(LS.entries, {}) || {};
    META = lsGet(LS.meta, {}) || {};
    CUSTOM = lsGet(LS.custom, {}) || {};
    DELETED = lsGet(LS.deleted, {}) || {};
    EDITS = lsGet(LS.edits, []) || [];
  }
  function persist() {
    lsSet(LS.entries, ENTRIES); lsSet(LS.meta, META);
    lsSet(LS.custom, CUSTOM); lsSet(LS.deleted, DELETED);
  }
  function persistEdits() {
    if (EDITS.length > 200) EDITS = EDITS.slice(0, 200);
    lsSet(LS.edits, EDITS);
  }

  /* ------------------------------------------------------------- Helpers */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function nowIso() {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  function pct(v) { const n = parseFloat(v); return isNaN(n) ? 0 : Math.round(n * 1000) / 10; }
  function fmtPct(v) { const p = pct(v); return (Number.isInteger(p) ? p : p.toFixed(1)) + " %"; }
  function getUser() { return lsGet(LS.user, "") || ""; }
  function setUser(v) { lsSet(LS.user, v || ""); }

  let toastEl = null;
  function toast(msg, type) {
    if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "toast"; document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.className = "toast show " + (type || "");
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => (toastEl.className = "toast"), 2600);
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  /* --------------------------------------------------------- Normalisation */
  function fmtNum(v) {
    const f = parseFloat(v);
    if (isNaN(f)) return "0";
    if (f === Math.trunc(f)) return String(Math.trunc(f));
    return String(f);
  }
  function normalize(field, value) {
    if (value === null || value === undefined) return null;
    if (field === "av") {
      const f = parseFloat(value);
      if (isNaN(f) || f === 0) return null;
      return fmtNum(f);
    }
    const s = String(value).trim();
    if (s === "") return null;
    if (field === "st" && ["non démarré", "non demarre"].indexOf(s.toLowerCase()) >= 0) return null;
    return s;
  }
  function _num(v) { const f = parseFloat(v); return isNaN(f) ? null : f; }

  /* --------------------------------------------------------- Cell access */
  function ck(lot, row, task, field) { return lot + "|" + row + "|" + task + "|" + field; }
  function entGet(lot, row, task, field) { return ENTRIES[ck(lot, row, task, field)]; }
  function entSet(lot, row, task, field, val) { ENTRIES[ck(lot, row, task, field)] = val; }
  function entDel(lot, row, task, field) { delete ENTRIES[ck(lot, row, task, field)]; delete META[ck(lot, row, task, field)]; }

  function nestedFromEntries() {
    const data = {};
    for (const k in ENTRIES) {
      const parts = k.split("|");
      const lot = parts[0], row = parts[1], task = parts[2], field = parts[3];
      (data[lot] || (data[lot] = {}));
      (data[lot][row] || (data[lot][row] = {}));
      (data[lot][row][task] || (data[lot][row][task] = {}));
      data[lot][row][task][field] = ENTRIES[k];
    }
    return data;
  }

  /* ------------------------------------------------ Structure (gabarit) */
  let STRUCT = null;                 // {project, lots:[...]}
  let TEMPLATE_AB = null;            // gabarit xlsx (ArrayBuffer)

  function baseLot(key) {
    if (!STRUCT) return null;
    return STRUCT.lots.find((l) => l.key === key) || null;
  }
  function baseRows(lot) { return lot.rows; }

  // clone d'un lot avec locaux personnalisés appliqués (comme db.lot_by_key)
  function effectiveLot(key) {
    const lot = baseLot(key);
    if (!lot) return null;
    const clone = {
      key: lot.key, sheet: lot.sheet, label: lot.label, tasks: lot.tasks,
      global: lot.global, levels: lot.levels.slice(),
      rows: lot.rows.map((r) => ({ row: r.row, niveau: r.niveau, designation: r.designation })),
    };
    const custom = CUSTOM[key] || {};
    const deleted = DELETED[key] || {};
    const existing = {};
    clone.rows.forEach((r) => (existing[r.row] = r));
    for (const rowNum in custom) {
      const c = custom[rowNum];
      if (existing[rowNum]) {
        if (c.designation) existing[rowNum].designation = c.designation;
        if (c.niveau) existing[rowNum].niveau = c.niveau;
      }
    }
    clone.rows = clone.rows.filter((r) => !(r.row in deleted));
    const have = {};
    clone.rows.forEach((r) => (have[r.row] = true));
    for (const rowNum in custom) {
      if (!have[rowNum] && !(rowNum in deleted)) {
        const c = custom[rowNum];
        clone.rows.push({
          row: parseInt(rowNum, 10),
          niveau: c.niveau || "",
          designation: c.designation || ("LOCAL " + rowNum),
        });
      }
    }
    clone.rows.sort((a, b) => a.row - b.row);
    // niveaux effectifs (union, ordre d'apparition)
    const levels = [];
    clone.rows.forEach((r) => { if (r.niveau && levels.indexOf(r.niveau) < 0) levels.push(r.niveau); });
    clone.levels = levels;
    return clone;
  }

  /* ---------------------------------------------------------- Écritures */
  function saveCells(updates, user) {
    const ts = nowIso();
    let n = 0;
    const upserts = [];
    for (const u of updates) {
      const lot = u.lot, row = parseInt(u.row, 10), task = u.task, field = u.field;
      const val = normalize(field, u.value);
      const oldv = entGet(lot, row, task, field);
      const oldVal = oldv === undefined ? null : oldv;
      if (oldVal === val) continue;
      if (val === null) {
        // « Pierre tombale » : on garde une trace horodatée de la case vidée
        // pour que la suppression se propage aux autres appareils.
        entDel(lot, row, task, field);
        upserts.push({ lot: lot, row: row, task: task, field: field, value: null, updated_by: user, updated_at: ts });
      } else {
        entSet(lot, row, task, field, val);
        META[ck(lot, row, task, field)] = { u: user, t: ts };
        upserts.push({ lot: lot, row: row, task: task, field: field, value: val, updated_by: user, updated_at: ts });
      }
      EDITS.unshift({ ts: ts, user: user, lot: lot, row: row, task: task, field: field, new_value: val });
      n++;
    }
    if (n) {
      persist(); persistEdits();
      enqueueCloud({ entries_upserts: upserts });
      markSaved();
    }
    return n;
  }

  function addCustomLocal(lotKey, designation, niveau, user) {
    const eff = effectiveLot(lotKey);
    if (!eff) throw new Error("lot inconnu");
    let maxBase = 0;
    eff.rows.forEach((r) => { if (r.row > maxBase) maxBase = r.row; });
    const custom = CUSTOM[lotKey] || {};
    for (const rn in custom) { if (parseInt(rn, 10) > maxBase) maxBase = parseInt(rn, 10); }
    const rowNum = maxBase + 1;
    (CUSTOM[lotKey] || (CUSTOM[lotKey] = {}))[rowNum] = {
      designation: designation, niveau: niveau || "", created_by: user, created_at: nowIso(),
    };
    // si ce numéro avait été supprimé auparavant, on annule la suppression
    const op = { custom_locals_upserts: [{ lot: lotKey, row_num: rowNum, designation: designation, niveau: niveau || "", created_by: user, created_at: nowIso() }] };
    if (DELETED[lotKey] && DELETED[lotKey][rowNum]) {
      delete DELETED[lotKey][rowNum];
      op.deleted_locals_deletes = [{ lot: lotKey, row_num: rowNum }];
    }
    persist();
    enqueueCloud(op);
    return rowNum;
  }

  function editLocal(lotKey, rowNum, designation, niveau, user) {
    (CUSTOM[lotKey] || (CUSTOM[lotKey] = {}))[rowNum] = {
      designation: designation, niveau: niveau || "", created_by: user, created_at: nowIso(),
    };
    if (DELETED[lotKey]) delete DELETED[lotKey][rowNum];
    persist();
    enqueueCloud({
      custom_locals_upserts: [{ lot: lotKey, row_num: rowNum, designation: designation, niveau: niveau || "", created_by: user, created_at: nowIso() }],
      deleted_locals_deletes: [{ lot: lotKey, row_num: rowNum }],
    });
  }

  function deleteCustomLocal(lotKey, rowNum, user) {
    rowNum = parseInt(rowNum, 10);
    // effacer les saisies de la ligne
    const prefix = lotKey + "|" + rowNum + "|";
    for (const k in ENTRIES) { if (k.indexOf(prefix) === 0) { delete ENTRIES[k]; delete META[k]; } }
    if (CUSTOM[lotKey]) delete CUSTOM[lotKey][rowNum];
    // La suppression est TOUJOURS marquée d'une pierre tombale : les autres
    // appareils l'apprendront à la synchronisation (et retireront la ligne).
    const ts = nowIso();
    (DELETED[lotKey] || (DELETED[lotKey] = {}))[rowNum] = { deleted_by: user, deleted_at: ts };
    persist();
    enqueueCloud({
      custom_locals_deletes: [{ lot: lotKey, row_num: rowNum }],
      deleted_locals_upserts: [{ lot: lotKey, row_num: rowNum, deleted_by: user, deleted_at: ts }],
    });
  }

  /* --------------------------------------------------- Tableau de bord */
  function buildSummary() {
    const data = nestedFromEntries();
    const lotsOut = [];
    const grand = [];
    for (const lot of STRUCT.lots) {
      const key = lot.key;
      const ld = data[key] || {};
      const taskIds = lot.tasks.map((t) => t.id);
      const counts = {}; STATUSES.forEach((s) => (counts[s] = 0));
      const advVals = [];
      const taskAdv = {}; taskIds.forEach((id) => (taskAdv[id] = []));
      let nbTouched = 0;
      for (const row of lot.rows) {
        const r = row.row;
        const rd = ld[r] || {};
        if (Object.keys(rd).length) nbTouched++;
        let gst = null;
        const sts = taskIds.map((t) => (rd[t] || {}).st || "Non démarré");
        if (sts.indexOf("Bloqué") >= 0) gst = "Bloqué";
        else if (sts.indexOf("Non conforme") >= 0) gst = "Non conforme";
        else if (sts.indexOf("À vérifier") >= 0) gst = "À vérifier";
        const vals = taskIds.map((t) => { const v = _num((rd[t] || {}).av); return v === null ? 0 : v; });
        vals.forEach((v, i) => taskAdv[taskIds[i]].push(v));
        const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
        advVals.push(avg);
        if (gst === null) gst = avg >= 1 ? "Terminé" : (avg > 0 ? "En cours" : "Non démarré");
        if (counts[gst] !== undefined) counts[gst]++;
      }
      const lotAvg = advVals.length ? advVals.reduce((a, b) => a + b, 0) / advVals.length : 0;
      grand.push(lotAvg);
      const tasksOut = lot.tasks.map((t) => {
        const vals = taskAdv[t.id];
        const saisis = lot.rows.filter((row) => _num(((ld[row.row] || {})[t.id] || {}).av) !== null).length;
        return {
          id: t.id, label: t.label, col: t.col,
          moyenne: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0,
          saisis: saisis, total: lot.rows.length,
        };
      });
      const lv = {};
      for (const row of lot.rows) {
        const rd = ld[row.row] || {};
        const vals = taskIds.map((t) => _num((rd[t] || {}).av) || 0);
        (lv[row.niveau] || (lv[row.niveau] = [])).push(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);
      }
      const levelsOut = Object.keys(lv).map((n) => ({
        niveau: n,
        moyenne: lv[n].length ? lv[n].reduce((a, b) => a + b, 0) / lv[n].length : 0,
        total: lv[n].length,
      }));
      lotsOut.push({
        key: key, label: lot.label, sheet: lot.sheet,
        nb_locaux: lot.rows.length, nb_taches: lot.tasks.length,
        avancement: lotAvg, nb_renseignes: nbTouched,
        status_counts: counts, tasks: tasksOut, levels: levelsOut,
      });
    }
    const overall = grand.length ? grand.reduce((a, b) => a + b, 0) / grand.length : 0;
    return { lots: lotsOut, global: overall };
  }

  function allDataForExport() {
    const data = nestedFromEntries();
    const bySheet = {};
    for (const lot of STRUCT.lots) {
      const ld = data[lot.key] || {};
      const out = {};
      for (const row of lot.rows) {
        const r = row.row;
        const rd = ld[r] || {};
        const rec = { av: {}, st: {}, obs: {} };
        for (const t of lot.tasks) {
          const d = rd[t.id] || {};
          if (d.av !== undefined && d.av !== "") rec.av[t.id] = d.av;
          if (d.st) rec.st[t.id] = d.st;
          if (d.obs) rec.obs[t.id] = d.obs;
        }
        const cm = (rd["__global__"] || {}).comment;
        if (cm) rec.comment = cm;
        out[r] = rec;
      }
      bySheet[lot.sheet] = out;
    }
    return bySheet;
  }

  /* ============================================================ EXPORT */
  function colToNum(letters) { let n = 0; for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
  function numToCol(n) { let s = ""; while (n > 0) { const r = (n - 1) % 26; n = Math.floor((n - 1) / 26); s = String.fromCharCode(65 + r) + s; } return s; }
  function xesc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function cellXml(ref, style, kind, value) {
    const s = style ? (' s="' + style + '"') : "";
    if (kind === "f") return '<c r="' + ref + '"' + s + '><f>' + xesc(value) + "</f></c>";
    if (kind === "n") return '<c r="' + ref + '"' + s + "><v>" + value + "</v></c>";
    return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + xesc(value) + "</t></is></c>";
  }
  function matchCell(inner, ref) {
    const re = new RegExp('<c r="' + escapeRe(ref) + '"(?:\\s[^>]*?)?(?:/>|>[\\s\\S]*?</c>)');
    return re.exec(inner);
  }
  function stripFormulaCaches(xml) {
    return xml.replace(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g, (cell) => {
      if (cell.indexOf("<f") === -1) return cell;
      return cell.replace(/<v>[\s\S]*?<\/v>/g, "");
    });
  }
  function setFormula(xml, ref, formula) {
    const m = matchCell(xml, ref);
    if (!m) return xml;
    const st = /\bs="(\d+)"/.exec(m[0]);
    const style = st ? (' s="' + st[1] + '"') : "";
    const nc = '<c r="' + ref + '"' + style + "><f>" + xesc(formula) + "</f></c>";
    return xml.slice(0, m.index) + nc + xml.slice(m.index + m[0].length);
  }
  function setText(xml, ref, text) {
    const m = matchCell(xml, ref);
    if (!m) return xml;
    const st = /\bs="(\d+)"/.exec(m[0]);
    const style = st ? (' s="' + st[1] + '"') : "";
    const nc = '<c r="' + ref + '"' + style + ' t="inlineStr"><is><t xml:space="preserve">' + xesc(text) + "</t></is></c>";
    return xml.slice(0, m.index) + nc + xml.slice(m.index + m[0].length);
  }
  function setCell(inner, ref, col, style, kind, value) {
    let newCell = cellXml(ref, style, kind, value);
    const m = matchCell(inner, ref);
    if (m) {
      const st = /\bs="(\d+)"/.exec(m[0]);
      if (st) newCell = cellXml(ref, st[1], kind, value);
      return inner.slice(0, m.index) + newCell + inner.slice(m.index + m[0].length);
    }
    const cells = Array.from(inner.matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g));
    for (const cm of cells) {
      const r = /r="([A-Z]+)\d+"/.exec(cm[0]);
      if (r && colToNum(r[1]) > col) return inner.slice(0, cm.index) + newCell + inner.slice(cm.index);
    }
    return inner + newCell;
  }
  function ranges(lot) {
    const start = lot.data_start;
    let end = start;
    lot.rows.forEach((r) => { if (r.row > end) end = r.row; });
    const sheet = lot.sheet;
    const col = numToCol(lot.global.moyenne_col);
    return ["'" + sheet + "'!$B$" + start + ":$B$" + end,
            "'" + sheet + "'!$" + col + "$" + start + ":$" + col + "$" + end];
  }
  function statusFormula(stRefs, moyenneCol, r) {
    const ors = (op) => stRefs.map((ref) => ref + '="' + op + '"').join(",");
    const moy = moyenneCol ? numToCol(moyenneCol) + r : "0";
    return 'IF(OR(' + ors("Bloqué") + '),"Bloqué",' +
      'IF(OR(' + ors("Non conforme") + '),"Non conforme",' +
      'IF(OR(' + ors("À vérifier") + '),"À vérifier",' +
      'IF(' + moy + '>=1,"Terminé",IF(' + moy + '>0,"En cours","Non démarré")))))';
  }
  function sheetCellUpdatesForLot(lot, data) {
    const updates = {};
    const g = lot.global;
    for (const row of lot.rows) {
      const r = row.row;
      const d = data[r] || {};
      const av = d.av || {}, st = d.st || {}, obs = d.obs || {};
      const cells = {};
      if (row.niveau) cells[lot.niveau_col] = ["s", row.niveau];
      for (const t of lot.tasks) {
        const c = t.col;
        const a = av[t.id];
        if (a !== undefined && a !== null && a !== "") cells[c] = ["n", fmtNum(a)];
        const sv = st[t.id];
        if (sv) cells[c + 1] = ["s", sv || "Non démarré"];
        const ov = obs[t.id];
        if (ov !== undefined && ov !== null && ov !== "") cells[c + 2] = ["s", ov];
      }
      if (g.moyenne_col) {
        const avCols = lot.tasks.map((t) => numToCol(t.col) + r);
        if (avCols.length) cells[g.moyenne_col] = ["f", "IFERROR(AVERAGE(" + avCols.join(",") + "),0)"];
        if (g.statut_col) {
          const stRefs = lot.tasks.map((t) => numToCol(t.col + 1) + r);
          cells[g.statut_col] = ["f", statusFormula(stRefs, g.moyenne_col, r)];
        }
        if (g.commentaire_col) {
          const cv = d.comment;
          if (cv !== undefined && cv !== null && cv !== "") cells[g.commentaire_col] = ["s", cv];
        }
      }
      updates[r] = cells;
    }
    return updates;
  }
  function patchSheetRows(xml, updates) {
    if (!updates || !Object.keys(updates).length) return xml;
    const styleByCol = {};
    for (const m of xml.matchAll(/<c r="([A-Z]+)\d+"[^>]*?\bs="(\d+)"/g)) {
      if (!(m[1] in styleByCol)) styleByCol[m[1]] = m[2];
    }
    return xml.replace(/(<row\b[^>]*>)([\s\S]*?)(<\/row>)/g, (whole, openTag, inner, close) => {
      const rm = /r="(\d+)"/.exec(openTag);
      if (!rm) return whole;
      const r = parseInt(rm[1], 10);
      const cells = updates[r];
      if (!cells) return whole;
      const cols = Object.keys(cells).map(Number).sort((a, b) => a - b);
      for (const col of cols) {
        const pair = cells[col];
        const ref = numToCol(col) + r;
        const fallback = styleByCol[numToCol(col)];
        inner = setCell(inner, ref, col, fallback, pair[0], pair[1]);
      }
      return openTag + inner + close;
    });
  }

  const DASH_ROW_SHEET = { 4: "AVANCEMENT CVC", 5: "AVANCEMENT PBS", 6: "AVCT CFO", 7: "AVANCEMENT CFA-SSI", 8: "AVANCEMENT CFA-SSI" };
  const RECAP_SHEET = { 6: "AVANCEMENT PBS", 7: "AVANCEMENT CVC", 8: "AVCT CFO", 9: "AVANCEMENT CFA-SSI" };
  const NIVEAU_PAR_LIGNE = { 2: "SS-2", 3: "SS-1", 4: "RDC", 5: "R+1", 6: "R+2", 7: "R+3", 8: "R+4", 9: "R+5", 10: "R+6", 11: "R+6", 12: "__AUCUN__" };
  const NIVEAU_LOT_BY_COL = { B: "AVANCEMENT CVC", C: "AVANCEMENT PBS", D: "AVCT CFO", E: "AVANCEMENT CFA-SSI", F: "AVANCEMENT CFA-SSI" };

  async function buildExport() {
    const zip = await JSZip.loadAsync(TEMPLATE_AB);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);

    const wbXml = await zip.file("xl/workbook.xml").async("string");
    const relsXml = await zip.file("xl/_rels/workbook.xml.rels").async("string");
    const relMap = {};
    for (const m of relsXml.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) relMap[m[1]] = m[2];
    const sheetFile = {};
    for (const m of wbXml.matchAll(/<sheet name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
      let target = relMap[m[2]] || "";
      target = target.replace("../", "");
      if (target.indexOf("xl/") !== 0) target = "xl/" + target.replace(/^\/+/, "");
      sheetFile[m[1]] = target;
    }

    const patched = {};
    const dataBySheet = allDataForExport();
    for (const lot of STRUCT.lots) {
      const sheet = lot.sheet;
      const path = sheetFile[sheet];
      if (!path) continue;
      const updates = sheetCellUpdatesForLot(lot, dataBySheet[sheet] || {});
      let xml = await zip.file(path).async("string");
      xml = patchSheetRows(xml, updates);
      patched[path] = xml;
    }

    for (const sheet of ["TABLEAU DE BORD", "AVANCEMENT PAR NIVEAU", "RECAP GENERAL"]) {
      const path = sheetFile[sheet];
      if (path && !(path in patched)) patched[path] = await zip.file(path).async("string");
    }

    const lotsBySheet = {};
    STRUCT.lots.forEach((l) => (lotsBySheet[l.sheet] = l));

    if (sheetFile["TABLEAU DE BORD"]) {
      const p = sheetFile["TABLEAU DE BORD"];
      let xml = patched[p];
      for (const r in DASH_ROW_SHEET) {
        const lot = lotsBySheet[DASH_ROW_SHEET[r]];
        if (!lot) continue;
        const rg = ranges(lot);
        const brange = rg[0], avrange = rg[1];
        const cnt = 'COUNTIF(' + brange + ',"<>")-COUNTIF(' + brange + ',"MOYENNE")';
        const avg = 'IFERROR(SUMPRODUCT((' + brange + '<>"MOYENNE")*' + avrange + ')/SUMPRODUCT(--(' + brange + '<>"MOYENNE")),0)';
        xml = setFormula(xml, "B" + r, cnt);
        xml = setFormula(xml, "C" + r, avg);
      }
      xml = setFormula(xml, "B10", "IFERROR('RECAP GENERAL'!B11,0)");
      patched[p] = xml;
    }

    if (sheetFile["RECAP GENERAL"]) {
      const p = sheetFile["RECAP GENERAL"];
      let xml = patched[p];
      for (const r in RECAP_SHEET) {
        const lot = lotsBySheet[RECAP_SHEET[r]];
        if (!lot) continue;
        const rg = ranges(lot);
        const avg = 'IFERROR(SUMPRODUCT((' + rg[0] + '<>"MOYENNE")*' + rg[1] + ')/SUMPRODUCT(--(' + rg[0] + '<>"MOYENNE")),0)';
        xml = setFormula(xml, "B" + r, avg);
      }
      patched[p] = xml;
    }

    if (sheetFile["AVANCEMENT PAR NIVEAU"]) {
      const p = sheetFile["AVANCEMENT PAR NIVEAU"];
      let xml = patched[p];
      const globCol = {};
      STRUCT.lots.forEach((l) => (globCol[l.sheet] = l.global.moyenne_col));
      for (let rr = 2; rr <= 12; rr++) {
        const niveau = NIVEAU_PAR_LIGNE[rr];
        for (const col in NIVEAU_LOT_BY_COL) {
          const sheet = NIVEAU_LOT_BY_COL[col];
          const gc = globCol[sheet];
          if (!gc) continue;
          const g = numToCol(gc);
          const f = 'IFERROR(AVERAGEIFS(\'' + sheet + "'!$" + g + ":$" + g + ",'" + sheet + "'!$A:$A,\"" + niveau + "\",'" + sheet + "'!$B:$B,\"<>MOYENNE\"),0)";
          const ref = col + rr;
          const m = matchCell(xml, ref);
          if (m) xml = xml.slice(0, m.index) + '<c r="' + ref + '"><f>' + xesc(f) + "</f></c>" + xml.slice(m.index + m[0].length);
        }
      }
      xml = setText(xml, "G12", "Locaux techniques : repartis sur plusieurs niveaux");
      patched[p] = xml;
    }

    const drop = {};
    for (const n of names) {
      if (n.indexOf("xl/externalLinks/") === 0) drop[n] = true;
      if (n === "xl/calcChain.xml") drop[n] = true;
    }

    const isWorksheet = (n) => n.indexOf("xl/worksheets/") === 0 && n.slice(-4) === ".xml";
    const isTextPart = (n) => isWorksheet(n) || n === "xl/workbook.xml" ||
      n === "xl/_rels/workbook.xml.rels" || n === "[Content_Types].xml";

    const zout = new JSZip();
    for (const n of names) {
      if (drop[n]) continue;
      let content;
      if (n in patched) content = patched[n];
      else if (isTextPart(n)) content = await zip.file(n).async("string");
      else content = await zip.file(n).async("uint8array");
      if (typeof content === "string") {
        if (isWorksheet(n)) content = stripFormulaCaches(content);
        if (n === "xl/workbook.xml") {
          content = content.replace(/<externalReferences>[\s\S]*?<\/externalReferences>/g, "");
          content = content.split('forceFullCalc="1"').join('forceFullCalc="1" fullCalcOnLoad="1"');
        } else if (n === "xl/_rels/workbook.xml.rels") {
          content = content.replace(/<Relationship[^>]*externalLink[^>]*\/>/g, "");
          content = content.replace(/<Relationship[^>]*calcChain[^>]*\/>/g, "");
        } else if (n === "[Content_Types].xml") {
          content = content.replace(/<Override[^>]*externalLinks\/[^>]*?\/>/g, "");
          content = content.replace(/<Override[^>]*calcChain\.xml[^>]*?\/>/g, "");
        }
      }
      zout.file(n, content);
    }
    return await zout.generateAsync({ type: "base64", compression: "DEFLATE" });
  }

  /* ============================================================ IMPORT */
  function cellValue(cell, off) {
    let v = cell ? cell.v : null;
    if (v === null || v === undefined) return null;
    if (off === 0) { // avancement (fraction 0..1)
      if (typeof v === "string") {
        const s = v.trim();
        if (s === "") return null;
        if (s.slice(-1) === "%") { const f = parseFloat(s) / 100; return isNaN(f) ? null : f; }
        const f = parseFloat(s);
        return isNaN(f) ? null : f;
      }
      if (typeof v === "number") return v > 1 ? v / 100 : v;
      return null;
    }
    return String(v);
  }
  function parseImportWorkbook(ab) {
    const wb = XLSX.read(new Uint8Array(ab), { type: "array" });
    const updates = [];
    for (const lot of STRUCT.lots) {
      const ws = wb.Sheets[lot.sheet];
      if (!ws) continue;
      for (const rowDef of baseRows(lot)) {
        const r = rowDef.row;
        for (const t of lot.tasks) {
          for (const off of [0, 1, 2]) {
            const col = t.col + off;
            const cell = ws[XLSX.utils.encode_cell({ r: r - 1, c: col - 1 })];
            const v = cellValue(cell, off);
            if (v === null) continue;
            const field = off === 0 ? "av" : off === 1 ? "st" : "obs";
            updates.push({ lot: lot.key, row: r, task: t.id, field: field, value: v });
          }
        }
        const gc = lot.global.commentaire_col;
        if (gc) {
          const cell = ws[XLSX.utils.encode_cell({ r: r - 1, c: gc - 1 })];
          const v = cellValue(cell, 2);
          if (v !== null) updates.push({ lot: lot.key, row: r, task: "__global__", field: "comment", value: v });
        }
      }
    }
    return updates;
  }

  /* ====================================================== SAUVEGARDE */
  let QUEUE = [];
  let CLOUD_STATE = { last_ok: null, last_error: null };
  let breakerUntil = 0;
  let flushTimer = null;

  function loadCloud() {
    QUEUE = lsGet(LS.queue, []) || [];
    CLOUD_STATE = lsGet(LS.states, { last_ok: null, last_error: null }) || { last_ok: null, last_error: null };
  }
  function saveQueue() { lsSet(LS.queue, QUEUE); }
  function saveCloudState() { lsSet(LS.states, CLOUD_STATE); }

  function enqueueCloud(op) {
    QUEUE.push(op); saveQueue(); updateNetUI(); scheduleFlush();
  }
  function scheduleFlush() { clearTimeout(flushTimer); flushTimer = setTimeout(flushCloud, 900); }

  async function suiFetch(path, opts) {
    opts = opts || {};
    const url = new URL(SUPABASE_URL + "/rest/v1" + path);
    if (opts.params) for (const k in opts.params) url.searchParams.set(k, opts.params[k]);
    const headers = {
      apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json", Accept: "application/json",
    };
    if (opts.prefer) headers["Prefer"] = opts.prefer;
    const res = await fetch(url.toString(), {
      method: opts.method || "GET", headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      let txt = "";
      try { txt = (await res.text()).slice(0, 200); } catch (e) {}
      throw new Error("HTTP " + res.status + " " + txt);
    }
    return res;
  }

  async function applyOp(op) {
    if (op.entries_upserts && op.entries_upserts.length) {
      await suiFetch("/entries", {
        method: "POST", params: { on_conflict: "lot,row,task,field" },
        body: op.entries_upserts, prefer: "resolution=merge-duplicates,return=minimal",
      });
    }
    const edel = op.entries_deletes || [];
    for (const d of edel) {
      const params = { lot: "eq." + d.lot, row: "eq." + d.row };
      if (d.task !== undefined && d.task !== null) params.task = "eq." + d.task;
      if (d.field !== undefined && d.field !== null) params.field = "eq." + d.field;
      await suiFetch("/entries", { method: "DELETE", params: params, prefer: "return=minimal" });
    }
    if (op.custom_locals_upserts && op.custom_locals_upserts.length) {
      await suiFetch("/custom_locals", { method: "POST", params: { on_conflict: "lot,row_num" }, body: op.custom_locals_upserts, prefer: "resolution=merge-duplicates,return=minimal" });
    }
    for (const d of (op.custom_locals_deletes || [])) {
      await suiFetch("/custom_locals", { method: "DELETE", params: { lot: "eq." + d.lot, row_num: "eq." + d.row_num }, prefer: "return=minimal" });
    }
    if (op.deleted_locals_upserts && op.deleted_locals_upserts.length) {
      await suiFetch("/deleted_locals", { method: "POST", params: { on_conflict: "lot,row_num" }, body: op.deleted_locals_upserts, prefer: "resolution=merge-duplicates,return=minimal" });
    }
    for (const d of (op.deleted_locals_deletes || [])) {
      await suiFetch("/deleted_locals", { method: "DELETE", params: { lot: "eq." + d.lot, row_num: "eq." + d.row_num }, prefer: "return=minimal" });
    }
  }

  async function flushCloud() {
    updateNetUI();
    if (!navigator.onLine) return;
    if (Date.now() < breakerUntil) return;
    while (QUEUE.length) {
      const op = QUEUE[0];
      try {
        await applyOp(op);
      } catch (e) {
        CLOUD_STATE.last_error = nowIso() + " — " + e.message;
        saveCloudState();
        breakerUntil = Date.now() + BREAKER_MS;
        updateNetUI();
        return;
      }
      QUEUE.shift(); saveQueue();
      CLOUD_STATE.last_ok = nowIso(); saveCloudState();
    }
    updateNetUI();
  }

  function updateNetUI() {
    const dot = document.getElementById("netStatus");
    const bar = document.getElementById("offlineBar");
    const online = navigator.onLine;
    const n = QUEUE.length;
    if (dot) {
      if (!online) { dot.className = "netstatus off"; dot.textContent = n ? "hors ligne · " + n : "hors ligne"; }
      else if (n) { dot.className = "netstatus sync"; dot.textContent = "sync · " + n; }
      else { dot.className = "netstatus on"; dot.textContent = "en ligne"; }
      dot.title = !online
        ? ("Hors ligne — " + n + " changement(s) en attente de sauvegarde")
        : (n ? "Sauvegarde vers le cloud…" : "Connecté au cloud");
    }
    if (bar) bar.hidden = online;
  }

  /* ---- Sauvegarde complète / restauration ---- */
  function orderFor(table) { return table === "entries" ? "lot,row,task,field" : "lot,row_num"; }

  async function selectAll(table) {
    const out = []; let offset = 0;
    for (;;) {
      const res = await suiFetch("/" + table, { params: { select: "*", limit: PAGE, offset: offset, order: orderFor(table) } });
      const page = await res.json();
      out.push.apply(out, page);
      if (page.length < PAGE) break;
      offset += PAGE;
    }
    return out;
  }
  async function suiCount(table) {
    const url = SUPABASE_URL + "/rest/v1/" + table + "?select=*&limit=1";
    const res = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, Prefer: "count=exact", Accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const cr = res.headers.get("Content-Range") || "";
    return cr.indexOf("/") >= 0 ? parseInt(cr.split("/")[1], 10) : 0;
  }
  async function syncSmallTable(table, rows, keys) {
    const conflict = keys.join(",");
    for (let i = 0; i < rows.length; i += BATCH) {
      await suiFetch("/" + table, { method: "POST", params: { on_conflict: conflict }, body: rows.slice(i, i + BATCH), prefer: "resolution=merge-duplicates,return=minimal" });
    }
  }
  function dumpAll() {
    const entries = [];
    for (const k in ENTRIES) {
      const p = k.split("|"); const m = META[k] || {};
      entries.push({ lot: p[0], row: parseInt(p[1], 10), task: p[2], field: p[3], value: ENTRIES[k], updated_by: m.u || "", updated_at: m.t || "" });
    }
    const custom = [];
    for (const lot in CUSTOM) for (const rn in CUSTOM[lot]) {
      const c = CUSTOM[lot][rn];
      custom.push({ lot: lot, row_num: parseInt(rn, 10), designation: c.designation, niveau: c.niveau || "", created_by: c.created_by || "", created_at: c.created_at || "" });
    }
    const deleted = [];
    for (const lot in DELETED) for (const rn in DELETED[lot]) {
      const d = DELETED[lot][rn];
      deleted.push({ lot: lot, row_num: parseInt(rn, 10), deleted_by: d.deleted_by || "", deleted_at: d.deleted_at || "" });
    }
    return { entries: entries, custom_locals: custom, deleted_locals: deleted };
  }
  function loadAll(payload, replace) {
    if (replace) { ENTRIES = {}; META = {}; CUSTOM = {}; DELETED = {}; }
    (payload.entries || []).forEach((e) => {
      const k = ck(e.lot, e.row, e.task, e.field);
      if (e.value === null || e.value === undefined || e.value === "") { delete ENTRIES[k]; delete META[k]; return; }
      ENTRIES[k] = e.value;
      if (e.updated_by || e.updated_at) META[k] = { u: e.updated_by || "", t: e.updated_at || "" };
    });
    (payload.custom_locals || []).forEach((c) => {
      (CUSTOM[c.lot] || (CUSTOM[c.lot] = {}))[c.row_num] = { designation: c.designation, niveau: c.niveau || "", created_by: c.created_by || "", created_at: c.created_at || "" };
    });
    (payload.deleted_locals || []).forEach((d) => {
      (DELETED[d.lot] || (DELETED[d.lot] = {}))[d.row_num] = { deleted_by: d.deleted_by || "", deleted_at: d.deleted_at || "" };
    });
    persist();
  }
  function localCounts() {
    let custom = 0, deleted = 0;
    for (const l in CUSTOM) custom += Object.keys(CUSTOM[l]).length;
    for (const l in DELETED) deleted += Object.keys(DELETED[l]).length;
    return { entries: Object.keys(ENTRIES).length, custom_locals: custom, deleted_locals: deleted };
  }

  async function cloudFullPush() {
    const dump = dumpAll();
    for (let i = 0; i < dump.entries.length; i += BATCH) {
      await suiFetch("/entries", { method: "POST", params: { on_conflict: "lot,row,task,field" }, body: dump.entries.slice(i, i + BATCH), prefer: "resolution=merge-duplicates,return=minimal" });
    }
    await syncSmallTable("custom_locals", dump.custom_locals, ["lot", "row_num"]);
    await syncSmallTable("deleted_locals", dump.deleted_locals, ["lot", "row_num"]);
    const now = nowIso();
    const payload = { entries: dump.entries, custom_locals: dump.custom_locals, deleted_locals: dump.deleted_locals };
    await suiFetch("/backups", { method: "POST", body: [{ kind: "full", nb_entries: dump.entries.length, nb_locals: dump.custom_locals.length + dump.deleted_locals.length, payload: payload }], prefer: "return=minimal" });
    await suiFetch("/sync_meta", { method: "POST", params: { on_conflict: "key" }, body: [{ key: "last_backup", value: now, updated_at: now }], prefer: "resolution=merge-duplicates,return=minimal" });
    try {
      const res = await suiFetch("/backups", { params: { select: "id", order: "id.desc", limit: 200 } });
      const ids = (await res.json()).map((r) => r.id);
      for (const old of ids.slice(10)) await suiFetch("/backups", { method: "DELETE", params: { id: "eq." + old }, prefer: "return=minimal" });
    } catch (e) {}
    return { entries: dump.entries.length, custom_locals: dump.custom_locals.length, deleted_locals: dump.deleted_locals.length, at: now };
  }
  async function cloudRestore(mode) {
    const payload = {
      entries: await selectAll("entries"),
      custom_locals: await selectAll("custom_locals"),
      deleted_locals: await selectAll("deleted_locals"),
    };
    loadAll(payload, mode !== "merge");
    return localCounts();
  }
  async function recentBackups(limit) {
    const res = await suiFetch("/backups", { params: { select: "id,created_at,kind,nb_entries,nb_locals", order: "id.desc", limit: limit || 10 } });
    return await res.json();
  }

  /* ---------------- Synchronisation bidirectionnelle (fusion) ----------------
     La copie en ligne sert de point de rendez-vous entre le site, les
     téléphones et les ordinateurs. À chaque cycle : on lit la copie en ligne,
     on la fusionne avec les données locales (la date d'écriture la plus
     récente gagne), puis on renvoie en ligne ce qui a changé ici.           */
  const ENTRY_FIELDS = ["lot", "row", "task", "field", "value", "updated_by", "updated_at"];
  const CUSTOM_FIELDS = ["lot", "row_num", "designation", "niveau", "created_by", "created_at"];
  const DELETED_FIELDS = ["lot", "row_num", "deleted_by", "deleted_at"];

  function idEntry(e) { return e.lot + "|" + e.row + "|" + e.task + "|" + e.field; }
  function idSmall(r) { return r.lot + "|" + r.row_num; }
  function rowSig(row, fields) {
    return fields.map((f) => (row[f] === null || row[f] === undefined ? "" : String(row[f]))).join("\u0001");
  }
  function mergeRows(localList, remoteList, keyOf, tfield, fields) {
    const loc = {}, rem = {};
    localList.forEach((r) => { loc[keyOf(r)] = r; });
    remoteList.forEach((r) => { rem[keyOf(r)] = r; });
    const merged = {}, push = [];
    const keys = {};
    Object.keys(loc).forEach((k) => (keys[k] = true));
    Object.keys(rem).forEach((k) => (keys[k] = true));
    for (const k in keys) {
      const l = loc[k], r = rem[k];
      if (!l) { merged[k] = r; continue; }
      if (!r) { merged[k] = l; push.push(l); continue; }
      if (String(r[tfield] || "").trim() > String(l[tfield] || "").trim()) merged[k] = r;
      else {
        merged[k] = l;
        if (rowSig(l, fields) !== rowSig(r, fields)) push.push(l);
      }
    }
    return { merged: merged, push: push };
  }

  function applyMergedRows(entries, custom, deleted) {
    ENTRIES = {}; META = {}; CUSTOM = {}; DELETED = {};
    entries.forEach((e) => {
      if (e.value === null || e.value === undefined || e.value === "") return;
      const k = ck(e.lot, e.row, e.task, e.field);
      ENTRIES[k] = e.value;
      if (e.updated_by || e.updated_at) META[k] = { u: e.updated_by || "", t: e.updated_at || "" };
    });
    custom.forEach((c) => {
      (CUSTOM[c.lot] || (CUSTOM[c.lot] = {}))[c.row_num] =
        { designation: c.designation, niveau: c.niveau || "", created_by: c.created_by || "", created_at: c.created_at || "" };
    });
    deleted.forEach((d) => {
      (DELETED[d.lot] || (DELETED[d.lot] = {}))[d.row_num] =
        { deleted_by: d.deleted_by || "", deleted_at: d.deleted_at || "" };
    });
    persist();
  }

  async function pullMerge() {
    const local = dumpAll();
    const remE = await selectAll("entries");
    const remC = await selectAll("custom_locals");
    const remD = await selectAll("deleted_locals");

    const e = mergeRows(local.entries, remE, idEntry, "updated_at", ENTRY_FIELDS);
    const c = mergeRows(local.custom_locals, remC, idSmall, "created_at", CUSTOM_FIELDS);
    const d = mergeRows(local.deleted_locals, remD, idSmall, "deleted_at", DELETED_FIELDS);

    // Un local ne peut pas être à la fois « ajouté » et « supprimé » :
    // la date la plus récente tranche.
    const dropC = [], dropD = [];
    for (const k in c.merged) {
      if (!d.merged[k]) continue;
      const cd = d.merged[k];
      if (String(cd.deleted_at || "").trim() >= String(c.merged[k].created_at || "").trim()) {
        delete c.merged[k];
        dropC.push({ lot: cd.lot, row_num: cd.row_num });
      } else {
        delete d.merged[k];
        dropD.push({ lot: cd.lot, row_num: cd.row_num });
      }
    }

    // Les cellules des locaux masqués/supprimés ne sont pas conservées.
    const hidden = {};
    for (const k in d.merged) { const r = d.merged[k]; hidden[r.lot + "|" + r.row_num] = true; }
    for (const k in e.merged) {
      const r = e.merged[k];
      if (hidden[r.lot + "|" + r.row]) delete e.merged[k];
    }

    const pushE = e.push.filter((r) => !hidden[r.lot + "|" + r.row]);
    const pushC = c.push.filter((r) => c.merged[idSmall(r)]);
    const pushD = d.push.filter((r) => d.merged[idSmall(r)]);

    const before = localCounts();
    applyMergedRows(Object.keys(e.merged).map((k) => e.merged[k]),
      Object.keys(c.merged).map((k) => c.merged[k]),
      Object.keys(d.merged).map((k) => d.merged[k]));
    const after = localCounts();

    const op = {};
    if (pushE.length) op.entries_upserts = pushE;
    if (pushC.length) op.custom_locals_upserts = pushC;
    if (pushD.length) op.deleted_locals_upserts = pushD;
    if (dropC.length) op.custom_locals_deletes = dropC;
    if (dropD.length) op.deleted_locals_deletes = dropD;
    if (Object.keys(op).length) enqueueCloud(op);

    const changed = before.entries !== after.entries ||
      before.custom_locals !== after.custom_locals ||
      before.deleted_locals !== after.deleted_locals;
    return { changed: changed, pushed: pushE.length + pushC.length + pushD.length, total: after.entries };
  }

  let syncing = false;
  async function syncNow(opts) {
    opts = opts || {};
    if (syncing) return null;
    if (!navigator.onLine) return null;
    if (Date.now() < breakerUntil) return null;
    syncing = true;
    let res = null;
    try {
      await flushCloud();          // 1. envoyer les changements en attente
      res = await pullMerge();     // 2. lire + fusionner ce qui vient d'ailleurs
      await flushCloud();          // 3. renvoyer ce que l'on a de plus récent
      CLOUD_STATE.last_ok = nowIso();
      CLOUD_STATE.last_error = null;
      saveCloudState();
      if (res.changed && opts.refresh !== false) {
        const h = location.hash || "#/";
        if (h === "#/" || h === "" || h === "#/cloud") render();
      }
    } catch (err) {
      CLOUD_STATE.last_error = nowIso() + " — " + err.message;
      saveCloudState();
      breakerUntil = Date.now() + BREAKER_MS;
    } finally {
      syncing = false;
      updateNetUI();
    }
    return res;
  }
  // Au tout premier lancement, si l'appareil est vide, on récupère la
  // sauvegarde en ligne (utile après une réinstallation ou un changement
  // de téléphone). Ne fait rien si des données existent déjà ou hors ligne.
  async function maybeInitialRestore() {
    try {
      if (lsGet("cavally.initialized", false)) return false;
      const c = localCounts();
      if (c.entries || c.custom_locals || c.deleted_locals) { lsSet("cavally.initialized", nowIso()); return false; }
      if (!navigator.onLine) return false;
      const nb = await suiCount("entries");
      const res = await pullMerge();
      await flushCloud();
      lsSet("cavally.initialized", nowIso());
      if (nb) toast("Données récupérées depuis la sauvegarde en ligne (" + nb + " cellules)", "ok");
      return true;
    } catch (e) { return false; }
  }

  /* ============================================================= VUES */
  const savedTimers = {};
  function markSaved() {
    const el = document.getElementById("saved");
    if (!el) return;
    el.classList.add("show");
    clearTimeout(savedTimers.s);
    savedTimers.s = setTimeout(() => el.classList.remove("show"), 1300);
  }

  function setActiveNav(name) {
    $$("#mainNav a").forEach((a) => {
      if (a.getAttribute("data-nav") === name) a.classList.add("active");
      else a.classList.remove("active");
    });
  }

  function levelCards(levels) {
    return '<div class="grid cols-3">' + levels.map((lv) =>
      '<div class="card tight"><div class="section-head"><strong>' + esc(lv.niveau) +
      '</strong><span class="nowrap">' + fmtPct(lv.moyenne) + '</span></div>' +
      '<div class="bar" style="margin:8px 0 6px"><span style="width:' + pct(lv.moyenne) + '%"></span></div>' +
      '<span class="small muted">' + lv.total + ' local(aux)</span></div>').join("") + "</div>";
  }

  function viewDashboard() {
    setActiveNav("home");
    const s = buildSummary();
    const activity = EDITS.slice(0, 20);
    let html = '<h1>Tableau de bord des travaux CET</h1>' +
      '<p class="sub">Projet CAVALLY — avancement consolidé de tous les lots. ' +
      '<span class="muted small">Données de cet appareil, sauvegardées automatiquement en ligne.</span></p>';
    html += '<div class="grid cols-4">' +
      '<div class="card kpi accent"><span class="lbl">Avancement global</span>' +
      '<span class="big">' + fmtPct(s.global) + '</span>' +
      '<div class="bar"><span style="width:' + pct(s.global) + '%"></span></div></div>';
    s.lots.forEach((l) => {
      html += '<div class="card kpi"><span class="lbl">' + esc(l.label) + '</span>' +
        '<span class="big">' + fmtPct(l.avancement) + '</span>' +
        '<div class="bar"><span style="width:' + pct(l.avancement) + '%"></span></div>' +
        '<span class="small muted">' + l.nb_locaux + ' locaux · ' + l.nb_taches + ' tâches de suivi</span>' +
        '<a class="btn mini" href="#/lot/' + l.key + '">Ouvrir le lot →</a></div>';
    });
    html += "</div>";

    html += '<h2>Répartition des statuts par lot</h2><div class="grid cols-2">';
    s.lots.forEach((l) => {
      html += '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center">' +
        '<strong>' + esc(l.label) + '</strong><a class="small" href="#/lot/' + l.key + '">détail →</a></div>' +
        '<div class="bar" style="margin:8px 0"><span style="width:' + pct(l.avancement) + '%"></span></div>' +
        '<div class="pill-count">';
      ["Terminé", "En cours", "Non démarré", "Bloqué", "Non conforme", "À vérifier"].forEach((st) => {
        html += '<span class="p"><span class="dot" style="background:' + STATUS_COLOR[st] + '"></span>' +
          esc(st) + ' <span class="badge">' + (l.status_counts[st] || 0) + "</span></span>";
      });
      html += "</div></div>";
    });
    html += "</div>";

    html += '<h2>Activité récente</h2><div class="card">';
    if (activity.length) {
      html += '<table class="tbl-cards"><thead><tr><th>Date</th><th>Utilisateur</th><th>Lot</th><th>Local (ligne)</th><th>Tâche</th><th>Champ</th><th>Nouvelle valeur</th></tr></thead><tbody>';
      activity.forEach((e) => {
        html += "<tr><td class=\"small nowrap\" data-label=\"Date\">" + esc(e.ts) + "</td>" +
          "<td data-label=\"Utilisateur\">" + esc(e.user) + "</td>" +
          "<td data-label=\"Lot\">" + esc(e.lot) + "</td>" +
          "<td data-label=\"Local\">" + esc(e.row) + "</td>" +
          '<td class="small" data-label="Tâche">' + esc(e.task) + "</td>" +
          "<td data-label=\"Champ\">" + esc(e.field) + "</td>" +
          "<td data-label=\"Nouvelle valeur\">" + esc(e.new_value) + "</td></tr>";
      });
      html += "</tbody></table>";
    } else {
      html += '<p class="empty">Aucune modification pour l\'instant. Ouvrez un lot pour commencer la saisie.</p>';
    }
    html += "</div>";

    html += '<h2>Détail des tâches par lot</h2><div class="grid cols-2">';
    s.lots.forEach((l) => {
      html += '<div class="card"><strong>' + esc(l.label) + '</strong>' +
        '<table class="tbl-cards" style="margin-top:8px"><thead><tr><th>Tâche</th><th class="right">Avancement</th><th class="right">Renseigné</th><th></th></tr></thead><tbody>';
      l.tasks.forEach((t) => {
        html += '<tr><td class="small" data-label="Tâche">' + esc(t.label) + "</td>" +
          '<td class="right nowrap" data-label="Avancement">' + fmtPct(t.moyenne) + "</td>" +
          '<td class="right small muted" data-label="Renseigné">' + t.saisis + "/" + t.total + "</td>" +
          '<td class="right no-label"><a class="btn mini" href="#/lot/' + l.key + "/task/" + encodeURIComponent(t.id) + '">Saisir</a></td></tr>';
      });
      html += "</tbody></table></div>";
    });
    html += "</div>";
    setView(html);
  }

  function viewLot(key) {
    setActiveNav("lot");
    const lot = effectiveLot(key);
    if (!lot) { setView('<p class="empty">Lot introuvable.</p>'); return; }
    const summary = buildSummary();
    const lotSum = summary.lots.find((l) => l.key === key) || { avancement: 0, tasks: [], levels: [] };

    let html = '<p class="crumbs"><a href="#/">← Tableau de bord</a></p>' +
      "<h1>" + esc(lot.label) + "</h1>" +
      '<p class="sub">' + lot.rows.length + " locaux · " + lot.tasks.length + " tâches · Avancement moyen <strong>" + fmtPct(lotSum.avancement) + "</strong></p>" +
      '<div class="toolbar">' +
      '<a class="btn primary" href="#/lot/' + lot.key + "/task/" + encodeURIComponent(lot.tasks[0].id) + '">Saisir une tâche</a>' +
      '<a class="btn" href="#/export">Exporter le fichier Excel</a></div>';

    html += "<h2>Avancement par niveau</h2>" + levelCards(lotSum.levels);

    html += '<h2>Tâches du lot</h2><div class="card"><table class="tbl-cards"><thead><tr><th>Tâche</th><th class="right">Avancement moyen</th><th class="right">Renseigné</th><th></th></tr></thead><tbody>';
    lotSum.tasks.forEach((t) => {
      html += '<tr><td data-label="Tâche">' + esc(t.label) + "</td>" +
        '<td class="right nowrap" data-label="Avancement moyen">' + fmtPct(t.moyenne) + "</td>" +
        '<td class="right muted" data-label="Renseigné">' + t.saisis + "/" + t.total + "</td>" +
        '<td class="right no-label"><a class="btn mini" href="#/lot/' + lot.key + "/task/" + encodeURIComponent(t.id) + '">Saisir</a></td></tr>';
    });
    html += "</tbody></table></div>";

    html += '<h2>Ajouter un local</h2><div class="card"><div class="toolbar">' +
      '<label class="fld grow"><span>Désignation</span><input id="newDesig" type="text" placeholder="Ex. Garage, Local annexe…"></label>' +
      '<label class="fld" style="min-width:160px"><span>Niveau</span><input id="newNiv" type="text" list="nivList" placeholder="RDC, R+1…">' +
      '<datalist id="nivList">' + lot.levels.map((lv) => '<option value="' + esc(lv) + '">').join("") + "</datalist></label>" +
      '<div style="align-self:flex-end"><button class="btn primary" id="addLocal">Ajouter</button></div></div>' +
      '<div class="small muted">Le numéro de ligne est attribué automatiquement, à la suite des locaux existants.</div>' +
      '<div id="addErr" class="small" style="color:var(--bad);margin-top:8px;display:none"></div></div>';

    html += "<h2>Locaux du lot</h2>";
    lot.levels.forEach((lvl) => {
      const rows = lot.rows.filter((r) => r.niveau === lvl);
      html += '<div class="card" style="margin-bottom:12px"><div class="section-head"><strong>' + esc(lvl) +
        '</strong><span class="small muted">' + rows.length + " local(aux)</span></div>" +
        '<div class="localgrid">' + rows.map((r) =>
          '<a class="chip" href="#/lot/' + lot.key + "/local/" + r.row + '">' + esc(r.designation) + "</a>").join("") +
        "</div></div>";
    });
    setView(html);

    $("#addLocal").addEventListener("click", () => {
      const desig = $("#newDesig").value.trim();
      const niv = $("#newNiv").value.trim();
      const err = $("#addErr");
      err.style.display = "none";
      if (!desig) { err.textContent = "La désignation est requise."; err.style.display = "block"; return; }
      try {
        addCustomLocal(lot.key, desig, niv, getUser() || "Anonyme");
        toast("Local ajouté", "ok");
        render();
      } catch (e) { err.textContent = e.message; err.style.display = "block"; }
    });
  }

  function viewTask(key, taskId) {
    setActiveNav("lot");
    const lot = effectiveLot(key);
    if (!lot) { setView('<p class="empty">Lot introuvable.</p>'); return; }
    const task = lot.tasks.find((t) => t.id === taskId) || lot.tasks[0];
    if (!task) { setView('<p class="empty">Tâche introuvable.</p>'); return; }

    let html = '<p class="crumbs"><a href="#/">Tableau de bord</a> › <a href="#/lot/' + lot.key + '">' + esc(lot.label) + "</a></p>" +
      "<h1>" + esc(lot.label) + ' — <span style="color:var(--primary)">' + esc(task.label) + "</span></h1>" +
      "<p class=\"sub\">Renseignez l'avancement (0–100 %), le statut et une observation pour chaque local. " +
      '<span id="saved" class="saved">✓ enregistré</span></p>';

    html += '<div class="filters"><div class="toolbar">' +
      '<label class="fld" style="min-width:160px"><span>Niveau</span><select id="fNiveau"><option value="">Tous les niveaux</option>' +
      lot.levels.map((lv) => '<option value="' + esc(lv) + '">' + esc(lv) + "</option>").join("") + "</select></label>" +
      '<label class="fld grow"><span>Recherche</span><input id="fSearch" type="search" placeholder="Nom du local…"></label>' +
      '<label class="fld" style="min-width:220px"><span>Tâche</span><select id="fTask">' +
      lot.tasks.map((t) => '<option value="' + esc(t.id) + '"' + (t.id === task.id ? " selected" : "") + ">" + esc(t.label) + "</option>").join("") +
      "</select></label></div></div>";

    html += '<div class="massfill card"><strong class="small">Remplissage groupé</strong> — appliquer aux lignes affichées :' +
      '<div class="toolbar" style="margin-top:12px">' +
      '<label class="fld" style="width:110px"><span>Avancement %</span><input id="massAv" type="number" min="0" max="100" step="5"></label>' +
      '<label class="fld" style="min-width:170px"><span>Statut</span><select id="massSt"><option value="">(ne pas changer)</option>' +
      STATUSES.map((s) => "<option>" + esc(s) + "</option>").join("") + "</select></label>" +
      '<div style="align-self:flex-end"><button class="btn primary" id="applyMass">Appliquer aux lignes affichées</button></div>' +
      '<div class="small muted" id="massCount" style="align-self:flex-end"></div></div></div>';

    html += '<div class="tablewrap"><table id="grid" class="tbl-cards"><thead><tr>' +
      '<th class="sticky-col" style="min-width:80px">Niveau</th><th style="min-width:260px">Désignation</th>' +
      '<th style="width:110px">Avancement %</th><th style="width:170px">Statut</th><th style="min-width:220px">Observation</th>' +
      '</tr></thead><tbody id="gridBody"></tbody></table></div>';
    setView(html);

    const tb = $("#gridBody");
    const frag = document.createDocumentFragment();
    lot.rows.forEach((r) => {
      const av = entGet(lot.key, r.row, task.id, "av");
      const st = entGet(lot.key, r.row, task.id, "st") || "Non démarré";
      const obs = entGet(lot.key, r.row, task.id, "obs") || "";
      const av100 = (av === undefined || av === "" || av === null) ? "" : (parseFloat(av) * 100);
      const tr = document.createElement("tr");
      tr.dataset.row = r.row;
      tr.dataset.niveau = r.niveau;
      tr.dataset.designation = r.designation;
      tr.innerHTML = '<td class="sticky-col nowrap" data-label="Niveau">' + esc(r.niveau) + "</td>" +
        '<td data-label="Désignation">' + esc(r.designation) +
        ' <span class="small local-link"><a href="#/lot/' + lot.key + "/local/" + r.row + '">voir toutes les tâches →</a></span></td>' +
        '<td data-label="Avancement %"><input class="field-av av" type="number" min="0" max="100" step="5" value="' + av100 + '"></td>' +
        '<td data-label="Statut"><select class="st">' + STATUSES.map((s) => "<option" + (s === st ? " selected" : "") + ">" + esc(s) + "</option>").join("") + "</select></td>" +
        '<td data-label="Observation"><input class="field-obs obs" type="text" value="' + esc(obs) + '" placeholder="observation…"></td>';
      frag.appendChild(tr);
    });
    tb.appendChild(frag);

    function rowUpdates(tr) {
      const row = parseInt(tr.dataset.row, 10);
      const updates = [];
      const avEl = tr.querySelector(".av"), stEl = tr.querySelector(".st"), obsEl = tr.querySelector(".obs");
      if (avEl) updates.push({ lot: lot.key, row: row, task: task.id, field: "av", value: avEl.value.trim() === "" ? "" : parseFloat(avEl.value) / 100 });
      if (stEl) updates.push({ lot: lot.key, row: row, task: task.id, field: "st", value: stEl.value });
      if (obsEl) updates.push({ lot: lot.key, row: row, task: task.id, field: "obs", value: obsEl.value });
      return updates;
    }

    tb.addEventListener("change", (e) => {
      const tr = e.target.closest("tr");
      if (!tr) return;
      const row = parseInt(tr.dataset.row, 10);
      let field = null, value = null;
      if (e.target.classList.contains("av")) { field = "av"; value = e.target.value.trim() === "" ? "" : parseFloat(e.target.value) / 100; }
      else if (e.target.classList.contains("st")) { field = "st"; value = e.target.value; }
      else if (e.target.classList.contains("obs")) { field = "obs"; value = e.target.value; }
      if (!field) return;
      saveCells([{ lot: lot.key, row: row, task: task.id, field: field, value: value }], getUser() || "Anonyme");
    });

    function visibleRows() {
      const lv = $("#fNiveau").value;
      const q = $("#fSearch").value.toLowerCase();
      return $$("#gridBody tr").filter((tr) => {
        if (lv && tr.dataset.niveau !== lv) return false;
        if (q && tr.dataset.designation.toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
    }
    function applyFilter() {
      const set = new Set(visibleRows());
      $$("#gridBody tr").forEach((tr) => (tr.style.display = set.has(tr) ? "" : "none"));
      updateMassCount();
    }
    function updateMassCount() { $("#massCount").textContent = visibleRows().length + " ligne(s) affichée(s)"; }

    $("#fNiveau").addEventListener("change", applyFilter);
    $("#fSearch").addEventListener("input", applyFilter);
    $("#fTask").addEventListener("change", (e) => { location.hash = "#/lot/" + lot.key + "/task/" + encodeURIComponent(e.target.value); });

    $("#applyMass").addEventListener("click", () => {
      const avRaw = $("#massAv").value.trim();
      const st = $("#massSt").value;
      if (avRaw === "" && st === "") { toast("Rien à appliquer", "err"); return; }
      const rows = visibleRows();
      if (!rows.length) return;
      if (!confirm("Appliquer à " + rows.length + " ligne(s) affichée(s) ?")) return;
      const updates = [];
      rows.forEach((tr) => {
        const row = parseInt(tr.dataset.row, 10);
        if (avRaw !== "") {
          tr.querySelector(".av").value = avRaw;
          updates.push({ lot: lot.key, row: row, task: task.id, field: "av", value: parseFloat(avRaw) / 100 });
        }
        if (st !== "") {
          tr.querySelector(".st").value = st;
          updates.push({ lot: lot.key, row: row, task: task.id, field: "st", value: st });
        }
      });
      saveCells(updates, getUser() || "Anonyme");
      toast(rows.length + " ligne(s) mises à jour", "ok");
    });

    applyFilter();
  }

  function viewLocal(key, rowStr) {
    setActiveNav("lot");
    const lot = effectiveLot(key);
    if (!lot) { setView('<p class="empty">Lot introuvable.</p>'); return; }
    const rowNum = parseInt(rowStr, 10);
    const local = lot.rows.find((r) => r.row === rowNum);
    if (!local) { setView('<p class="empty">Local introuvable.</p>'); return; }

    let html = '<p class="crumbs"><a href="#/">Tableau de bord</a> › <a href="#/lot/' + lot.key + '">' + esc(lot.label) + "</a></p>" +
      "<h1>" + esc(local.designation) + "</h1>" +
      '<p class="sub">Niveau ' + esc(local.niveau || "—") + " · " + esc(lot.label) + " — renseignez toutes les tâches de ce local. " +
      '<span id="saved" class="saved">✓ enregistré</span></p>';

    html += '<div class="tablewrap"><table id="tasks" class="tbl-cards"><thead><tr><th style="min-width:260px">Tâche</th>' +
      '<th style="width:110px">Avancement %</th><th style="width:170px">Statut</th><th style="min-width:220px">Observation</th></tr></thead>' +
      '<tbody id="tasksBody"></tbody></table></div>';

    const comment = (entGet(lot.key, rowNum, "__global__", "comment")) || "";
    html += "<h2>Commentaire général du local</h2><div class=\"card\">" +
      '<textarea id="comment" rows="3" placeholder="Commentaire global sur ce local…">' + esc(comment) + "</textarea></div>";

    html += '<div class="grid cols-2" style="margin-top:16px">' +
      '<div class="card"><strong>Modifier ce local</strong><div class="toolbar" style="margin-top:12px">' +
      '<label class="fld grow"><span>Désignation</span><input id="editDesig" type="text" value="' + esc(local.designation) + '"></label>' +
      '<label class="fld" style="min-width:150px"><span>Niveau</span><input id="editNiv" type="text" list="nivList" value="' + esc(local.niveau) + '">' +
      '<datalist id="nivList">' + lot.levels.map((lvl) => '<option value="' + esc(lvl) + '">').join("") + "</datalist></label>" +
      '<div style="align-self:flex-end"><button class="btn primary" id="editLocal">Enregistrer</button></div></div>' +
      '<div id="editErr" class="small" style="color:var(--bad);display:none"></div></div>' +
      '<div class="card"><strong>Supprimer ce local</strong>' +
      '<p class="small muted" style="margin:8px 0 12px">Supprime ce local et toutes ses saisies. Un local d\'origine est masqué (conservé dans le modèle Excel).</p>' +
      '<button class="btn danger" id="delLocal">Supprimer ce local</button>' +
      '<div id="delErr" class="small" style="color:var(--bad);margin-top:8px;display:none"></div></div></div>';
    setView(html);

    const tb = $("#tasksBody");
    lot.tasks.forEach((t) => {
      const av = entGet(lot.key, rowNum, t.id, "av");
      const st = entGet(lot.key, rowNum, t.id, "st") || "Non démarré";
      const obs = entGet(lot.key, rowNum, t.id, "obs") || "";
      const av100 = (av === undefined || av === "" || av === null) ? "" : (parseFloat(av) * 100);
      const tr = document.createElement("tr");
      tr.dataset.task = t.id;
      tr.innerHTML = '<td data-label="Tâche">' + esc(t.label) + "</td>" +
        '<td data-label="Avancement %"><input class="av field-av" type="number" min="0" max="100" step="5" value="' + av100 + '"></td>' +
        '<td data-label="Statut"><select class="st">' + STATUSES.map((s) => "<option" + (s === st ? " selected" : "") + ">" + esc(s) + "</option>").join("") + "</select></td>" +
        '<td data-label="Observation"><input class="obs field-obs" type="text" value="' + esc(obs) + '" placeholder="observation…"></td>';
      tb.appendChild(tr);
    });

    tb.addEventListener("change", (e) => {
      const tr = e.target.closest("tr");
      if (!tr || !tr.dataset.task) return;
      const task = tr.dataset.task;
      let field = null, value = null;
      if (e.target.classList.contains("av")) { field = "av"; value = e.target.value.trim() === "" ? "" : parseFloat(e.target.value) / 100; }
      else if (e.target.classList.contains("st")) { field = "st"; value = e.target.value; }
      else if (e.target.classList.contains("obs")) { field = "obs"; value = e.target.value; }
      if (!field) return;
      saveCells([{ lot: lot.key, row: rowNum, task: task, field: field, value: value }], getUser() || "Anonyme");
    });
    $("#comment").addEventListener("change", (e) => {
      saveCells([{ lot: lot.key, row: rowNum, task: "__global__", field: "comment", value: e.target.value }], getUser() || "Anonyme");
    });
    $("#delLocal").addEventListener("click", () => {
      if (!confirm("Supprimer ce local ? Cela effacera toutes les saisies de ce local.")) return;
      deleteCustomLocal(lot.key, rowNum, getUser() || "Anonyme");
      toast("Local supprimé", "ok");
      location.hash = "#/lot/" + lot.key;
    });
    $("#editLocal").addEventListener("click", () => {
      const desig = $("#editDesig").value.trim();
      const niv = $("#editNiv").value.trim();
      const err = $("#editErr");
      err.style.display = "none";
      if (!desig) { err.textContent = "La désignation est requise."; err.style.display = "block"; return; }
      editLocal(lot.key, rowNum, desig, niv, getUser() || "Anonyme");
      toast("Local modifié", "ok");
      render();
    });
  }

  /* Prépare la liste des cellules à écrire pour un import.
     mode "complete" (défaut) : ne remplit que les cases vides — rien n'est écrasé.
     mode "replace" : met à jour toutes les cases présentes dans le fichier. */
  function planImport(updates, mode) {
    if (mode === "replace") return { updates: updates, skipped: 0 };
    let skipped = 0;
    const keep = updates.filter((u) => {
      const cur = entGet(u.lot, parseInt(u.row, 10) || u.row, u.task, u.field);
      if (cur !== undefined && cur !== null && cur !== "") { skipped++; return false; }
      return normalize(u.field, u.value) !== null;
    });
    return { updates: keep, skipped: skipped };
  }

  function viewImport() {
    setActiveNav("import");
    let html = "<h1>Importer un fichier Excel</h1>" +
      '<p class="sub">Choisissez un classeur déjà rempli (même modèle que « SUIVI TRAVAUX CAVALLY »). Les avancements, ' +
      "statuts et observations des 4 feuilles de lots seront <strong>ajoutés</strong> à la base de cet appareil.</p>" +
      '<div class="grid cols-2"><div class="card">' +
      '<label class="small muted">Fichier .xlsx</label><br>' +
      '<input id="impFile" type="file" accept=".xlsx,.xlsm" style="margin:10px 0 16px">' +
      '<div class="card tight" style="margin:0 0 16px"><div class="small" style="margin-bottom:8px">' +
      "<strong>Que faire des cases déjà remplies ?</strong></div>" +
      '<label class="small" style="display:block;margin-bottom:8px">' +
      '<input type="radio" name="impMode" value="complete" checked> ' +
      "<strong>Compléter</strong> — ne remplir que les cases vides (rien n'est écrasé)</label>" +
      '<label class="small" style="display:block">' +
      '<input type="radio" name="impMode" value="replace"> ' +
      "Mettre à jour — remplacer aussi les valeurs déjà saisies</label></div>" +
      '<button class="btn primary" id="impBtn">Importer</button>' +
      '<div id="impMsg" class="small" style="margin-top:10px"></div></div>' +
      '<div class="card"><strong>Bon à savoir</strong><ul class="small">' +
      "<li>Par défaut, l'import <strong>ne supprime ni n'écrase rien</strong> : il complète les cases vides.</li>" +
      "<li>Les cases vides du fichier ne modifient rien.</li>" +
      "<li>Les niveaux/locaux doivent correspondre au modèle (les lignes sont repérées par numéro de ligne).</li>" +
      "<li>Le fichier est ensuite synchronisé automatiquement avec le site et les autres appareils.</li>" +
      "<li>Les formules de synthèse du fichier ne sont pas reprises (recalculées à l'export).</li>" +
      "</ul></div></div>";
    setView(html);

    $("#impBtn").addEventListener("click", async () => {
      const f = $("#impFile").files[0];
      const msg = $("#impMsg");
      const checked = $('input[name="impMode"]:checked');
      const mode = checked ? checked.value : "complete";
      if (!f) { msg.style.color = "var(--bad)"; msg.textContent = "Aucun fichier sélectionné."; return; }
      msg.style.color = "var(--muted)";
      msg.textContent = "Lecture du fichier…";
      try {
        const ab = await f.arrayBuffer();
        const plan = planImport(parseImportWorkbook(ab), mode);
        const n = saveCells(plan.updates, getUser() || "Anonyme");
        msg.style.color = "var(--ok)";
        msg.textContent = mode === "replace"
          ? ("Import réussi : " + n + " cellule(s) mise(s) à jour.")
          : ("Import réussi : " + n + " case(s) complétée(s), " + plan.skipped + " déjà remplie(s) conservée(s).");
        toast("Import réussi : " + n + " cellule(s)", "ok");
        syncNow();
      } catch (e) {
        msg.style.color = "var(--bad)";
        msg.textContent = "Erreur pendant l'import : " + e.message;
      }
    });
  }

  function viewExport() {
    setActiveNav("export");
    const s = buildSummary();
    let html = "<h1>Générer le fichier Excel</h1>" +
      "<p class=\"sub\">Le fichier produit reprend exactement le modèle d'origine : mises en forme, listes déroulantes, " +
      "graphique du tableau de bord et onglets de synthèse — remplis avec les données saisies par chacun.</p>" +
      '<div class="grid cols-2"><div class="card kpi">' +
      '<span class="lbl">Avancement global actuel</span><span class="big">' + fmtPct(s.global) + "</span>" +
      '<div class="grid cols-2" style="margin-top:10px">';
    s.lots.forEach((l) => {
      html += "<div><strong class=\"small\">" + esc(l.label) + '</strong><div class="bar sm"><span style="width:' + pct(l.avancement) + '%"></span></div>' +
        '<span class="small muted">' + fmtPct(l.avancement) + "</span></div>";
    });
    html += "</div>" +
      '<button class="btn primary" id="expBtn" style="margin-top:18px">⬇ Télécharger le classeur complet</button>' +
      '<div id="expMsg" class="small" style="margin-top:10px"></div>' +
      '<p class="small muted" style="margin-top:10px">Nom du fichier :<br><code>SUIVI TRAVAUX CAVALLY - JJMMAAAA.xlsx</code></p></div>' +
      '<div class="card"><strong>Contenu du fichier</strong><ul class="small">' +
      "<li><strong>TABLEAU DE BORD</strong> — synthèse par lot (avancement, statuts) + graphique</li>" +
      "<li><strong>AVANCEMENT PAR NIVEAU</strong> — avancement par niveau et par lot</li>" +
      "<li><strong>AVANCEMENT PBS / CVC / AVCT CFO / CFA-SSI</strong> — saisie détaillée</li>" +
      "<li><strong>RECAP GENERAL</strong> — récapitulatif des lots</li></ul>" +
      '<p class="small muted">Ouvre le fichier dans Excel ou LibreOffice : il se recalcule automatiquement.</p></div></div>';
    setView(html);

    $("#expBtn").addEventListener("click", async () => {
      const btn = $("#expBtn"), msg = $("#expMsg");
      btn.disabled = true;
      msg.style.color = "var(--muted)";
      msg.textContent = "Génération du classeur…";
      try {
        const b64 = await buildExport();
        const d = new Date(), p = (n) => String(n).padStart(2, "0");
        const name = "SUIVI TRAVAUX CAVALLY - " + p(d.getDate()) + p(d.getMonth() + 1) + d.getFullYear() + ".xlsx";
        const mode = await saveFile(b64, name, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        msg.style.color = "var(--ok)";
        msg.textContent = mode === "share" ? "Fichier généré — choisissez où l'enregistrer / l'envoyer." : "Téléchargement lancé : " + name;
      } catch (e) {
        msg.style.color = "var(--bad)";
        msg.textContent = "Erreur pendant la génération : " + e.message;
      }
      btn.disabled = false;
    });
  }

  function viewCloud() {
    setActiveNav("cloud");
    let html = "<h1>Sauvegarde et synchronisation</h1>" +
      '<p class="sub">Vos données sont enregistrées sur cet appareil. Elles sont aussi <strong>synchronisées ' +
      "automatiquement</strong> avec le site et vos autres appareils (téléphone, ordinateur) via la base en ligne : " +
      "ce que vous saisissez ici apparaît partout, et inversement.</p>" +
      '<div class="card"><div id="cloudStatus" class="small">Chargement…</div>' +
      '<div class="toolbar" style="margin-top:14px">' +
      '<button class="btn primary" id="syncBtn">🔄 Synchroniser maintenant</button>' +
      '<button class="btn" id="pushBtn">☁ Créer un instantané</button></div>' +
      '<div id="cloudMsg" class="small" style="margin-top:10px"></div></div>' +
      '<h2>Récupération des données</h2><div class="card">' +
      '<p class="small muted">Utile après une réinstallation. La fusion ne supprime jamais les données les plus récentes.</p>' +
      '<div class="toolbar">' +
      '<button class="btn" id="restoreMerge">⬇ Fusionner la copie en ligne</button>' +
      '<button class="btn danger" id="restoreReplace">⬇ Remplacer par la copie en ligne</button></div></div>' +
      '<h2>Derniers instants sauvegardés</h2><div class="card"><div id="backupList" class="small muted">Chargement…</div></div>';
    setView(html);

    async function refresh() {
      const st = $("#cloudStatus"), bl = $("#backupList");
      const local = localCounts();
      let cloud = { entries: "—", custom_locals: "—", deleted_locals: "—" };
      const online = navigator.onLine;
      try {
        for (const t of ["entries", "custom_locals", "deleted_locals"]) cloud[t] = await suiCount(t);
      } catch (e) { cloud = { entries: "?", custom_locals: "?", deleted_locals: "?" }; }
      st.innerHTML =
        "<div><strong>Sur cet appareil :</strong> " + local.entries + " cellules · " + local.custom_locals + " locaux ajoutés · " + local.deleted_locals + " locaux masqués</div>" +
        "<div style='margin-top:4px'><strong>En ligne :</strong> " + cloud.entries + " cellules · " + cloud.custom_locals + " locaux ajoutés · " + cloud.deleted_locals + " locaux masqués</div>" +
        "<div style='margin-top:4px'><strong>En attente d'envoi :</strong> " + QUEUE.length + " changement(s)</div>" +
        "<div style='margin-top:4px'><strong>Dernière synchro réussie :</strong> " + (CLOUD_STATE.last_ok || "—") + " &nbsp; <strong>Dernière erreur :</strong> " + (CLOUD_STATE.last_error || "—") + "</div>" +
        "<div style='margin-top:4px'>" + (online ? "🟢 en ligne — synchronisation automatique active" : "🟠 hors ligne — les changements partiront au retour du réseau") + "</div>";
      try {
        const list = await recentBackups(10);
        if (list.length) {
          bl.innerHTML = "<table class='tbl-cards'><thead><tr><th>Date</th><th>Type</th><th class='right'>Cellules</th><th class='right'>Locaux</th></tr></thead><tbody>" +
            list.map((b) => "<tr><td data-label='Date'>" + esc(b.created_at) + "</td><td data-label='Type'>" + esc(b.kind) + "</td>" +
              "<td class='right' data-label='Cellules'>" + b.nb_entries + "</td><td class='right' data-label='Locaux'>" + b.nb_locals + "</td></tr>").join("") +
            "</tbody></table>";
        } else bl.innerHTML = '<span class="muted">Aucun instantané pour l\'instant.</span>';
      } catch (e) { bl.innerHTML = '<span class="muted">Liste indisponible (hors ligne ?).</span>'; }
    }
    refresh();

    $("#syncBtn").addEventListener("click", async () => {
      const msg = $("#cloudMsg");
      msg.style.color = "var(--muted)"; msg.textContent = "Synchronisation en cours…";
      const r = await syncNow({ refresh: false });
      if (!navigator.onLine) { msg.style.color = "var(--bad)"; msg.textContent = "Hors ligne — réessayez au retour du réseau."; return; }
      if (!r) { msg.style.color = "var(--bad)"; msg.textContent = "Synchronisation impossible pour le moment."; return; }
      msg.style.color = "var(--ok)";
      msg.textContent = "Synchronisé : " + r.total + " cellules sur cet appareil" +
        (r.pushed ? ", " + r.pushed + " envoyée(s) depuis ici" : "") + ".";
      refresh();
    });

    $("#pushBtn").addEventListener("click", async () => {
      const msg = $("#cloudMsg");
      msg.style.color = "var(--muted)"; msg.textContent = "Création de l'instantané…";
      try {
        const r = await cloudFullPush();
        msg.style.color = "var(--ok)";
        msg.textContent = "Instantané créé : " + r.entries + " cellules, " + r.custom_locals + " locaux ajoutés, " + r.deleted_locals + " locaux masqués (" + r.at + ").";
        toast("Instantané en ligne créé", "ok");
      } catch (e) { msg.style.color = "var(--bad)"; msg.textContent = "Échec : " + e.message; }
      refresh();
    });

    async function doRestore(mode) {
      const msg = $("#cloudMsg");
      if (mode === "replace" && !confirm("Remplacer TOUTES les données de cet appareil par la copie en ligne ?")) return;
      msg.style.color = "var(--muted)"; msg.textContent = "Restauration…";
      try {
        const c = await cloudRestore(mode);
        msg.style.color = "var(--ok)";
        msg.textContent = "Restauration réussie (" + mode + ") : " + c.entries + " cellules.";
        toast("Restauration réussie", "ok");
        syncNow({ refresh: false });
      } catch (e) { msg.style.color = "var(--bad)"; msg.textContent = "Échec : " + e.message; }
      refresh();
    }
    $("#restoreMerge").addEventListener("click", () => doRestore("merge"));
    $("#restoreReplace").addEventListener("click", () => doRestore("replace"));
  }

  function viewHelp() {
    setActiveNav("help");
    setView('<div class="help"><h1>Mode d\'emploi</h1>' +
      '<p class="sub">Application de suivi des travaux CET — Projet CAVALLY.</p>' +
      '<div class="card">' +
      "<h3>1. Indiquer votre nom</h3><p>En haut à droite, saisissez votre nom. Il est mémorisé sur l'appareil et attaché à chaque modification (traçabilité). Aucun compte n'est nécessaire.</p>" +
      "<h3>2. Saisir l'avancement</h3><p>Deux façons de travailler :</p><ul>" +
      "<li><strong>Par tâche</strong> (recommandé) : choisissez un lot, puis une tâche. La liste des locaux s'affiche ; renseignez l'avancement, le statut et une observation. Le <em>remplissage groupé</em> applique une valeur à toutes les lignes affichées (filtrées par niveau).</li>" +
      "<li><strong>Par local</strong> : depuis un lot, cliquez sur un local pour renseigner toutes ses tâches et un commentaire général.</li></ul>" +
      '<p class="small muted">Chaque champ est enregistré automatiquement sur l\'appareil.</p>' +
      "<h3>3. Statuts</h3><ul><li>Non démarré · En cours · Terminé · Bloqué · Non conforme · À vérifier</li></ul>" +
      "<p>Le statut global d'un local et sa moyenne sont recalculés automatiquement à partir des tâches.</p>" +
      "<h3>4. Importer</h3><p>Page <em>Importer</em> : choisissez un classeur rempli (même modèle). Par défaut l'import <strong>complète</strong> les cases vides — il n'écrase jamais une saisie déjà faite.</p>" +
      "<h3>5. Générer le fichier Excel</h3><p>Page <em>Exporter</em> : le classeur complet, identique au modèle, rempli avec vos saisies. Sur téléphone, utilisez « Partager » pour l'enregistrer ou l'envoyer.</p>" +
      "<h3>6. Travailler sans réseau</h3><ul>" +
      "<li>Le voyant en haut à droite affiche <strong>hors ligne</strong> et le nombre de changements en attente.</li>" +
      "<li>Tout est <strong>conservé sur l'appareil</strong> et <strong>synchronisé automatiquement</strong> dès que le réseau revient.</li></ul>" +
      "<h3>7. Synchronisation automatique</h3><p>Vos saisies partent en ligne et celles des autres appareils (site web, autres téléphones, ordinateurs) arrivent ici <strong>sans rien faire</strong>. En cas de conflit, la modification la plus récente est conservée ; rien n'est écrasé en bloc. La page <em>Sauvegarde</em> permet de voir l'état, de synchroniser tout de suite ou de créer un instantané daté.</p>" +
      "</div></div>");
  }

  /* ---------------------------------------------------- Sauvegarde fichier */
  function base64ToBlob(b64, mime) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  async function saveFile(b64, filename, mime) {
    const Cap = window.Capacitor;
    if (Cap && Cap.Plugins && Cap.Plugins.Filesystem && Cap.Plugins.Filesystem.writeFile) {
      try {
        const res = await Cap.Plugins.Filesystem.writeFile({
          path: filename, data: b64, directory: "CACHE", recursive: true,
        });
        if (Cap.Plugins.Share && Cap.Plugins.Share.share) {
          await Cap.Plugins.Share.share({
            title: filename, url: res.uri, files: [res.uri],
            dialogTitle: "Enregistrer ou envoyer",
          });
          return "share";
        }
        return "filesystem";
      } catch (e) { /* bascule sur la méthode navigateur */ }
    }
    const blob = base64ToBlob(b64, mime);
    if (navigator.canShare && navigator.canShare({ files: [new File([blob], filename, { type: mime })] })) {
      try {
        await navigator.share({ files: [new File([blob], filename, { type: mime })], title: filename });
        return "share";
      } catch (e) {}
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return "download";
  }

  /* ============================================================ ROUTAGE */
  function setView(html) {
    const view = document.getElementById("view");
    view.innerHTML = html;
    window.scrollTo(0, 0);
  }

  function render() {
    const h = location.hash.replace(/^#/, "") || "/";
    const parts = h.split("/").filter(Boolean);
    if (parts.length === 0) return viewDashboard();
    if (parts[0] === "lot") {
      if (parts[2] === "task") return viewTask(parts[1], decodeURIComponent(parts[3] || ""));
      if (parts[2] === "local") return viewLocal(parts[1], parts[3]);
      return viewLot(parts[1]);
    }
    if (parts[0] === "import") return viewImport();
    if (parts[0] === "export") return viewExport();
    if (parts[0] === "cloud") return viewCloud();
    if (parts[0] === "help") return viewHelp();
    return viewDashboard();
  }

  /* ============================================================= INIT */
  function initChrome() {
    // thème
    const root = document.documentElement;
    const btn = document.getElementById("themeBtn");
    function icon() { if (btn) btn.textContent = root.getAttribute("data-theme") === "dark" ? "☀️" : "🌙"; }
    icon();
    if (btn) btn.addEventListener("click", () => {
      const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem(LS.theme, next); } catch (e) {}
      icon();
    });
    // menu mobile
    const nav = document.getElementById("mainNav"), tg = document.getElementById("navToggle");
    if (nav && tg) tg.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      tg.setAttribute("aria-expanded", open ? "true" : "false");
    });
    nav.addEventListener("click", (e) => { if (e.target.tagName === "A") nav.classList.remove("open"); });
    // nom utilisateur
    const u = document.getElementById("userName");
    if (u) {
      u.value = getUser();
      u.addEventListener("change", () => { setUser(u.value.trim()); toast("Utilisateur : " + (u.value.trim() || "Anonyme"), "ok"); });
    }
    // réseau + synchronisation automatique
    updateNetUI();
    window.addEventListener("online", () => { updateNetUI(); flushCloud(); });
    window.addEventListener("offline", updateNetUI);
    window.addEventListener("focus", () => syncNow());
    document.addEventListener("visibilitychange", () => { if (!document.hidden) syncNow(); });
    setInterval(() => syncNow(), 15000);        // synchronisation régulière
    setInterval(updateNetUI, 5000);
    // Retour au premier plan (Android / iOS)
    try {
      const Cap = window.Capacitor;
      if (Cap && Cap.Plugins && Cap.Plugins.App && Cap.Plugins.App.addListener) {
        Cap.Plugins.App.addListener("appStateChange", (st) => { if (st && st.isActive) syncNow(); });
      }
    } catch (e) {}
    window.addEventListener("hashchange", render);
  }

  async function init() {
    initChrome();
    loadStorage();
    loadCloud();
    try {
      const [stRes, tplRes] = await Promise.all([
        fetch("assets/structure.json"),
        fetch("assets/cavally_template.xlsx"),
      ]);
      if (!stRes.ok) throw new Error("structure introuvable (" + stRes.status + ")");
      STRUCT = await stRes.json();
      TEMPLATE_AB = await tplRes.arrayBuffer();
    } catch (e) {
      setView('<div class="card"><strong>Erreur de chargement</strong><p class="small">' + esc(e.message) +
        "</p><p class=\"small muted\">Réinstallez ou rouvrez l'application.</p></div>");
      return;
    }
    render();
    updateNetUI();
    // au tout premier lancement : récupération automatique de la sauvegarde en ligne
    maybeInitialRestore().then((restored) => {
      syncNow();
      if (restored) render();
    });
    // service worker (hors-ligne / installable)
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  /* API interne (utilisée par les tests automatisés de l'application). */
  window.CavApp = {
    setStructure(s) { STRUCT = s; },
    setTemplate(ab) { TEMPLATE_AB = ab; },
    setData(e, c, d) { ENTRIES = e || {}; CUSTOM = c || {}; DELETED = d || {}; },
    getData() { return { ENTRIES: ENTRIES, CUSTOM: CUSTOM, DELETED: DELETED, META: META }; },
    pullMerge: pullMerge, syncNow: syncNow, mergeRows: mergeRows,
    applyMergedRows: applyMergedRows, planImport: planImport,
    loadCloud: loadCloud, flushCloud: flushCloud,
    buildSummary, allDataForExport, buildExport, parseImportWorkbook, effectiveLot,
    saveCells, addCustomLocal, editLocal, deleteCustomLocal,
    normalize, localCounts, dumpAll, loadAll, ck,
  };

  document.addEventListener("DOMContentLoaded", init);
})();
