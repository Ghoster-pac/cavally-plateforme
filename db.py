"""Acces aux donnees (SQLite) pour la plateforme CAVALLY."""
from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import datetime

import excel_engine as E

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
TEMPLATE = os.environ.get(
    "CAVALLY_TEMPLATE", os.path.join(BASE_DIR, "files", "cavally_template.xlsx")
)
DB_PATH = os.environ.get("CAVALLY_DB", os.path.join(DATA_DIR, "cavally.db"))
STRUCTURE_PATH = os.path.join(DATA_DIR, "structure.json")

# Mode journal SQLite. WAL est plus rapide en local, mais peut provoquer des
# erreurs "database is locked" sur les systemes de fichiers en reseau (comme
# PythonAnywhere) : on peut alors forcer DELETE via CAVALLY_JOURNAL=DELETE.
JOURNAL_MODE = (os.environ.get("CAVALLY_JOURNAL") or "WAL").upper()

_STRUCT = None


def now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _cloud_mirror(**kwargs):
    """Recopie des changements vers la base en ligne (best effort).

    Ne doit jamais faire echouer une ecriture locale : toute erreur est
    silencieuse. La sauvegarde peut etre coupee par CAVALLY_CLOUD=off.
    """
    try:
        import cloud
        if cloud.enabled():
            cloud.mirror(**kwargs)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Structure
# ---------------------------------------------------------------------------


def get_structure(refresh: bool = False) -> dict:
    global _STRUCT
    if _STRUCT is not None and not refresh:
        return _STRUCT
    if os.path.exists(STRUCTURE_PATH) and not refresh:
        with open(STRUCTURE_PATH, encoding="utf-8") as f:
            _STRUCT = json.load(f)
        return _STRUCT
    st = E.parse_structure(TEMPLATE)
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(STRUCTURE_PATH, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=2)
    _STRUCT = st
    return st


def lot_by_key(structure: dict, key: str, include_custom: bool = True):
    for lot in structure["lots"]:
        if lot["key"] == key:
            if include_custom:
                try:
                    custom = get_custom_locals(key)
                    deleted = get_deleted_rows(key)
                    existing = {r["row"]: r for r in lot["rows"]}
                    # applique les modifications (désignation/niveau) aux lignes existantes
                    for c in custom:
                        if c["row_num"] in existing:
                            existing[c["row_num"]]["designation"] = (
                                c.get("designation") or existing[c["row_num"]]["designation"])
                            if c.get("niveau"):
                                existing[c["row_num"]]["niveau"] = c["niveau"]
                    # retire les locaux masqués/supprimés
                    if deleted:
                        lot["rows"] = [r for r in lot["rows"] if r["row"] not in deleted]
                    # ajoute les locaux personnalisés (nouveaux numéros)
                    existing2 = {r["row"] for r in lot["rows"]}
                    for c in custom:
                        if c["row_num"] not in existing2 and c["row_num"] not in deleted:
                            lot["rows"].append({
                                "row": c["row_num"],
                                "niveau": c.get("niveau") or "",
                                "designation": c.get("designation") or f"LOCAL {c['row_num']}",
                            })
                    lot["rows"].sort(key=lambda r: r["row"])
                except Exception:
                    pass
            return lot
    return None


def col_map(lot: dict) -> dict:
    """{col: (task_id, field)} pour une feuille de lot."""
    m = {}
    for t in lot["tasks"]:
        m[t["col"]] = (t["id"], "av")
        m[t["col"] + 1] = (t["id"], "st")
        m[t["col"] + 2] = (t["id"], "obs")
    g = lot["global"]
    if g.get("commentaire_col"):
        m[g["commentaire_col"]] = ("__global__", "comment")
    return m


# ---------------------------------------------------------------------------
# Base
# ---------------------------------------------------------------------------


def connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    try:
        con.execute("PRAGMA journal_mode=%s" % JOURNAL_MODE)
    except sqlite3.Error:
        con.execute("PRAGMA journal_mode=DELETE")
    con.execute("PRAGMA busy_timeout=30000")
    return con


def init_db(force_seed: bool = False):
    con = connect()
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS entries (
            lot TEXT NOT NULL,
            row INTEGER NOT NULL,
            task TEXT NOT NULL,
            field TEXT NOT NULL,
            value TEXT,
            updated_by TEXT,
            updated_at TEXT,
            PRIMARY KEY (lot, row, task, field)
        );
        CREATE TABLE IF NOT EXISTS edits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT, user TEXT, lot TEXT, row INTEGER, task TEXT, field TEXT,
            old_value TEXT, new_value TEXT
        );
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS custom_locals (
            lot TEXT NOT NULL,
            row_num INTEGER NOT NULL,
            designation TEXT NOT NULL,
            niveau TEXT,
            created_by TEXT,
            created_at TEXT,
            PRIMARY KEY (lot, row_num)
        );
        CREATE TABLE IF NOT EXISTS deleted_locals (
            lot TEXT NOT NULL,
            row_num INTEGER NOT NULL,
            deleted_by TEXT,
            deleted_at TEXT,
            PRIMARY KEY (lot, row_num)
        );
        """
    )
    con.commit()
    seeded = con.execute("SELECT value FROM meta WHERE key='seeded'").fetchone()
    if not seeded or force_seed:
        seed(con)
        con.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('seeded',?)", (now_iso(),))
        con.commit()
    con.close()


def seed(con, clear: bool = False):
    st = get_structure()
    if clear:
        con.execute("DELETE FROM entries")
    values = E.read_cells(TEMPLATE, st)
    ts = now_iso()
    for lot in st["lots"]:
        cm = col_map(lot)
        sheet_vals = values.get(lot["sheet"], {})
        for (r, c), v in sheet_vals.items():
            if c not in cm:
                continue
            task, field = cm[c]
            val = normalize(field, _to_text(field, v) if v is not None else None)
            if val is None:
                continue
            con.execute(
                "INSERT OR IGNORE INTO entries(lot,row,task,field,value,updated_by,updated_at)"
                " VALUES(?,?,?,?,?,?,?)",
                (lot["key"], r, task, field, val, "(import initial)", ts),
            )


def _to_text(field, v):
    if field == "av":
        try:
            return E._fmt_num(v)
        except Exception:
            return str(v)
    return str(v)


def normalize(field: str, value):
    """Ignore les valeurs par defaut (0 % / Non demarre / vide)."""
    if value is None:
        return None
    if field == "av":
        try:
            f = float(value)
        except (TypeError, ValueError):
            return None
        if f == 0:
            return None
        return E._fmt_num(f)
    s = str(value).strip()
    if s == "":
        return None
    if field == "st" and s.lower() in ("non démarré", "non demarre"):
        return None
    return s


# ---------------------------------------------------------------------------
# Lecture / ecriture
# ---------------------------------------------------------------------------


def get_task_values(lot_key: str, task_id: str):
    con = connect()
    rows = con.execute(
        "SELECT row, task, field, value, updated_by, updated_at FROM entries "
        "WHERE lot=? AND (task=? OR (task='__global__' AND ?='__global__'))",
        (lot_key, task_id, task_id),
    ).fetchall()
    con.close()
    return [dict(x) for x in rows]


def get_lot_values(lot_key: str):
    con = connect()
    rows = con.execute(
        "SELECT row, task, field, value, updated_by, updated_at FROM entries WHERE lot=?",
        (lot_key,),
    ).fetchall()
    con.close()
    out = {}
    for x in rows:
        out.setdefault(x["row"], {}).setdefault(x["task"], {})[x["field"]] = x["value"]
    return out


def save_cells(updates: list, user: str):
    """updates: [{lot,row,task,field,value}] ; last-write-wins."""
    con = connect()
    ts = now_iso()
    n = 0
    upserts = []
    deletes = []
    for u in updates:
        lot = u["lot"]; row = int(u["row"]); task = u["task"]; field = u["field"]
        val = normalize(field, u.get("value"))
        old = con.execute(
            "SELECT value FROM entries WHERE lot=? AND row=? AND task=? AND field=?",
            (lot, row, task, field),
        ).fetchone()
        oldv = old["value"] if old else None
        if oldv == val:
            continue
        if val is None:
            con.execute("DELETE FROM entries WHERE lot=? AND row=? AND task=? AND field=?",
                        (lot, row, task, field))
            deletes.append({"lot": lot, "row": row, "task": task, "field": field})
        else:
            con.execute(
                "INSERT INTO entries(lot,row,task,field,value,updated_by,updated_at) "
                "VALUES(?,?,?,?,?,?,?) "
                "ON CONFLICT(lot,row,task,field) DO UPDATE SET "
                "value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at",
                (lot, row, task, field, val, user, ts),
            )
            upserts.append({"lot": lot, "row": row, "task": task, "field": field,
                            "value": val, "updated_by": user, "updated_at": ts})
        con.execute(
            "INSERT INTO edits(ts,user,lot,row,task,field,old_value,new_value) VALUES(?,?,?,?,?,?,?,?)",
            (ts, user, lot, row, task, field, oldv, val),
        )
        n += 1
    con.commit()
    con.close()
    if n:
        _cloud_mirror(entries_upserts=upserts, entries_deletes=deletes)
    return n



def recent_edits(limit: int = 40):
    con = connect()
    rows = con.execute(
        "SELECT * FROM edits ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    con.close()
    return [dict(x) for x in rows]


# ---------------------------------------------------------------------------
# Agregation pour le tableau de bord
# ---------------------------------------------------------------------------

STATUS_LIST = ["Non démarré", "En cours", "Terminé", "Bloqué", "Non conforme", "À vérifier"]


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def build_summary():
    st = get_structure()
    con = connect()
    allrows = con.execute("SELECT lot,row,task,field,value FROM entries").fetchall()
    con.close()
    data = {}
    for x in allrows:
        data.setdefault(x["lot"], {}).setdefault(x["row"], {}).setdefault(x["task"], {})[x["field"]] = x["value"]

    lots_out = []
    grand = []
    for lot in st["lots"]:
        key = lot["key"]
        ld = data.get(key, {})
        task_ids = [t["id"] for t in lot["tasks"]]
        counts = {s: 0 for s in STATUS_LIST}
        adv_vals = []
        task_adv = {t["id"]: [] for t in lot["tasks"]}
        nb_touched = 0
        for row in lot["rows"]:
            r = row["row"]
            rd = ld.get(r, {})
            touched = bool(rd)
            nb_touched += 1 if touched else 0
            # statut global du local
            gst = None
            sts = [((rd.get(t) or {}).get("st") or "Non démarré") for t in task_ids]
            if "Bloqué" in sts:
                gst = "Bloqué"
            elif "Non conforme" in sts:
                gst = "Non conforme"
            elif "À vérifier" in sts:
                gst = "À vérifier"
            # moyenne du local = moyenne de TOUTES les taches (0 par defaut), comme le classeur
            vals = []
            for t in task_ids:
                v = _num((rd.get(t) or {}).get("av"))
                v = v if v is not None else 0.0
                vals.append(v)
                task_adv[t].append(v)
            avg = sum(vals) / len(vals) if vals else 0.0
            adv_vals.append(avg)
            if gst is None:
                gst = "Terminé" if avg >= 1 else ("En cours" if avg > 0 else "Non démarré")
            if gst in counts:
                counts[gst] += 1
        lot_avg = (sum(adv_vals) / len(adv_vals)) if adv_vals else 0
        grand.append(lot_avg)
        tasks_out = []
        for t in lot["tasks"]:
            vals = task_adv[t["id"]]
            saisis = sum(1 for row in lot["rows"]
                         if _num(((ld.get(row["row"], {}) or {}).get(t["id"], {}) or {}).get("av")) is not None)
            tasks_out.append({
                "id": t["id"],
                "label": t["label"],
                "col": t["col"],
                "moyenne": (sum(vals) / len(vals)) if vals else 0,
                "saisis": saisis,
                "total": len(lot["rows"]),
            })
        # progression par niveau
        lv = {}
        for row in lot["rows"]:
            rd = ld.get(row["row"], {})
            vals = [_num((rd.get(t) or {}).get("av")) or 0.0 for t in task_ids]
            lv.setdefault(row["niveau"], []).append(sum(vals) / len(vals) if vals else 0.0)
        levels_out = [{"niveau": n, "moyenne": (sum(v) / len(v)) if v else 0,
                       "total": len(v)} for n, v in lv.items()]
        lots_out.append({
            "key": key,
            "label": lot["label"],
            "sheet": lot["sheet"],
            "nb_locaux": len(lot["rows"]),
            "nb_taches": len(lot["tasks"]),
            "avancement": lot_avg,
            "nb_renseignes": nb_touched,
            "status_counts": counts,
            "tasks": tasks_out,
            "levels": levels_out,
        })
    overall = (sum(grand) / len(grand)) if grand else 0
    return {"lots": lots_out, "global": overall}


def all_data_for_export():
    """Reconstruit {sheet: {row: {av,st,obs,comment}}} pour l'export."""
    st = get_structure()
    con = connect()
    allrows = con.execute("SELECT lot,row,task,field,value FROM entries").fetchall()
    con.close()
    data = {}
    for x in allrows:
        data.setdefault(x["lot"], {}).setdefault(x["row"], {}).setdefault(x["task"], {})[x["field"]] = x["value"]

    by_sheet = {}
    for lot in st["lots"]:
        key = lot["key"]
        ld = data.get(key, {})
        out = {}
        for row in lot["rows"]:
            r = row["row"]
            rd = ld.get(r, {})
            rec = {"av": {}, "st": {}, "obs": {}}
            for t in lot["tasks"]:
                d = rd.get(t["id"], {}) or {}
                if d.get("av") not in (None, ""):
                    rec["av"][t["id"]] = d["av"]
                if d.get("st"):
                    rec["st"][t["id"]] = d["st"]
                if d.get("obs"):
                    rec["obs"][t["id"]] = d["obs"]
            cm = (rd.get("__global__", {}) or {}).get("comment")
            if cm:
                rec["comment"] = cm
            out[r] = rec
        by_sheet[lot["sheet"]] = out
    return by_sheet


def import_cells(parsed: dict, structure: dict, user: str):
    """parsed: {sheet: {(row,col): value}} -> maj entries (av/st/obs/comment)."""
    updates = []
    for lot in structure["lots"]:
        cm = col_map(lot)
        for (r, c), v in (parsed.get(lot["sheet"]) or {}).items():
            if c not in cm:
                continue
            task, field = cm[c]
            if v is None or v == "":
                continue
            updates.append({"lot": lot["key"], "row": r, "task": task,
                            "field": field, "value": _to_text(field, v)})
    return save_cells(updates, user)


def get_custom_locals(lot_key: str):
    con = connect()
    rows = con.execute(
        "SELECT row_num, designation, niveau, created_by, created_at FROM custom_locals "
        "WHERE lot=? ORDER BY row_num",
        (lot_key,),
    ).fetchall()
    con.close()
    return [dict(x) for x in rows]


def get_deleted_rows(lot_key: str):
    con = connect()
    rows = con.execute(
        "SELECT row_num FROM deleted_locals WHERE lot=?", (lot_key,)
    ).fetchall()
    con.close()
    return {x["row_num"] for x in rows}


def add_custom_local(lot_key: str, designation: str, niveau: str | None, user: str):
    st = get_structure()
    lot = lot_by_key(st, lot_key)
    if not lot:
        raise ValueError("lot inconnu")
    con = connect()
    # trouver prochain numero libre au-delà des lignes existantes
    max_base = 0
    for r in lot["rows"]:
        if r["row"] > max_base:
            max_base = r["row"]
    # aussi vérifier custom
    cur = con.execute("SELECT MAX(row_num) as m FROM custom_locals WHERE lot=?", (lot_key,)).fetchone()
    if cur and cur["m"] is not None and cur["m"] > max_base:
        max_base = cur["m"]
    row_num = max_base + 1
    ts = now_iso()
    try:
        con.execute(
            "INSERT INTO custom_locals(lot,row_num,designation,niveau,created_by,created_at) VALUES(?,?,?,?,?,?)",
            (lot_key, row_num, designation, niveau or "", user, ts),
        )
        con.commit()
        created = row_num
    except sqlite3.IntegrityError:
        # si conflit, réessayer avec +2
        row_num += 1
        con.execute(
            "INSERT INTO custom_locals(lot,row_num,designation,niveau,created_by,created_at) VALUES(?,?,?,?,?,?)",
            (lot_key, row_num, designation, niveau or "", user, ts),
        )
        con.commit()
        created = row_num
    # rafraîchir le cache de structure (les locaux viennent de la base)
    global _STRUCT
    _STRUCT = None
    con.close()
    _cloud_mirror(custom_locals_upserts=[{
        "lot": lot_key, "row_num": created, "designation": designation,
        "niveau": niveau or "", "created_by": user, "created_at": ts,
    }])
    return created


def edit_local(lot_key: str, row_num: int, designation: str, niveau: str | None, user: str):
    con = connect()
    exists = con.execute(
        "SELECT 1 FROM custom_locals WHERE lot=? AND row_num=?", (lot_key, row_num)
    ).fetchone()
    if exists:
        con.execute(
            "UPDATE custom_locals SET designation=?, niveau=? WHERE lot=? AND row_num=?",
            (designation, niveau or "", lot_key, row_num),
        )
    else:
        con.execute(
            "INSERT INTO custom_locals(lot,row_num,designation,niveau,created_by,created_at) "
            "VALUES(?,?,?,?,?,?)",
            (lot_key, row_num, designation, niveau or "", user, now_iso()),
        )
    con.execute("DELETE FROM deleted_locals WHERE lot=? AND row_num=?", (lot_key, row_num))
    con.commit()
    con.close()
    global _STRUCT
    _STRUCT = None
    _cloud_mirror(
        custom_locals_upserts=[{
            "lot": lot_key, "row_num": row_num, "designation": designation,
            "niveau": niveau or "", "created_by": user, "created_at": now_iso(),
        }],
        deleted_locals_deletes=[{"lot": lot_key, "row_num": row_num}],
    )


def delete_custom_local(lot_key: str, row_num: int, user: str = "Anonyme"):
    con = connect()
    # supprimer les saisies associées
    con.execute("DELETE FROM entries WHERE lot=? AND row=?", (lot_key, row_num))
    con.execute("DELETE FROM edits WHERE lot=? AND row=?", (lot_key, row_num))
    custom = con.execute(
        "SELECT 1 FROM custom_locals WHERE lot=? AND row_num=?", (lot_key, row_num)
    ).fetchone()
    if custom:
        con.execute("DELETE FROM custom_locals WHERE lot=? AND row_num=?", (lot_key, row_num))
        mirror = {"entries_deletes": [{"lot": lot_key, "row": row_num}],
                  "custom_locals_deletes": [{"lot": lot_key, "row_num": row_num}]}
    else:
        # ligne d'origine : on la masque (on ne peut pas retirer une ligne du gabarit Excel)
        con.execute(
            "INSERT OR REPLACE INTO deleted_locals(lot,row_num,deleted_by,deleted_at) VALUES(?,?,?,?)",
            (lot_key, row_num, user, now_iso()),
        )
        mirror = {"entries_deletes": [{"lot": lot_key, "row": row_num}],
                  "deleted_locals_upserts": [{"lot": lot_key, "row_num": row_num,
                                              "deleted_by": user, "deleted_at": now_iso()}]}
    con.commit()
    con.close()
    global _STRUCT
    _STRUCT = None
    _cloud_mirror(**mirror)


def forgot(seed_clear: bool = False):
    con = connect()
    if seed_clear:
        con.execute("DELETE FROM entries")
        con.execute("DELETE FROM custom_locals")
        con.execute("DELETE FROM deleted_locals")
        con.commit()
    seed(con, clear=seed_clear)
    con.commit()
    con.close()
    global _STRUCT
    _STRUCT = None


# ---------------------------------------------------------------------------
# Sauvegarde en ligne : export / import de toute la base
# ---------------------------------------------------------------------------


def count_all() -> dict:
    con = connect()

    def c(t):
        return con.execute("SELECT COUNT(*) AS n FROM " + t).fetchone()["n"]

    out = {"entries": c("entries"), "custom_locals": c("custom_locals"),
           "deleted_locals": c("deleted_locals")}
    con.close()
    return out


def dump_all() -> dict:
    """Exporte toute la base locale (pour la sauvegarde en ligne)."""
    con = connect()
    entries = [dict(x) for x in con.execute(
        "SELECT lot,row,task,field,value,updated_by,updated_at FROM entries").fetchall()]
    customs = [dict(x) for x in con.execute(
        "SELECT lot,row_num,designation,niveau,created_by,created_at "
        "FROM custom_locals").fetchall()]
    deleted = [dict(x) for x in con.execute(
        "SELECT lot,row_num,deleted_by,deleted_at FROM deleted_locals").fetchall()]
    con.close()
    return {"entries": entries, "custom_locals": customs, "deleted_locals": deleted}


def load_all(payload: dict, replace: bool = True) -> dict:
    """Reecrit la base locale depuis la copie en ligne.

    replace=True : la base locale est entierement remplacee.
    replace=False : la copie en ligne est fusionnee dans la base locale.
    """
    con = connect()
    if replace:
        con.execute("DELETE FROM entries")
        con.execute("DELETE FROM custom_locals")
        con.execute("DELETE FROM deleted_locals")
    for e in payload.get("entries", []):
        con.execute(
            "INSERT INTO entries(lot,row,task,field,value,updated_by,updated_at) "
            "VALUES(?,?,?,?,?,?,?) "
            "ON CONFLICT(lot,row,task,field) DO UPDATE SET "
            "value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at",
            (e["lot"], int(e["row"]), e["task"], e["field"], e.get("value"),
             e.get("updated_by"), e.get("updated_at")),
        )
    for c_ in payload.get("custom_locals", []):
        con.execute(
            "INSERT INTO custom_locals(lot,row_num,designation,niveau,created_by,created_at) "
            "VALUES(?,?,?,?,?,?) ON CONFLICT(lot,row_num) DO UPDATE SET "
            "designation=excluded.designation, niveau=excluded.niveau",
            (c_["lot"], int(c_["row_num"]), c_.get("designation") or "",
             c_.get("niveau") or "", c_.get("created_by"), c_.get("created_at")),
        )
    for d in payload.get("deleted_locals", []):
        con.execute(
            "INSERT OR REPLACE INTO deleted_locals(lot,row_num,deleted_by,deleted_at) "
            "VALUES(?,?,?,?)",
            (d["lot"], int(d["row_num"]), d.get("deleted_by"), d.get("deleted_at")),
        )
    con.commit()
    con.close()
    global _STRUCT
    _STRUCT = None
    return count_all()


