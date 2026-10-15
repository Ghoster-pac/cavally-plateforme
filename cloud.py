"""Sauvegarde en ligne — miroir Supabase / PostgreSQL.

Ce module copie les donnees de la base locale SQLite vers une base Supabase
(PostgreSQL) afin de disposer d'une seconde base en ligne.

Deux mecanismes complementaires :

1. Miroir en temps reel : chaque saisie enregistree dans la base locale est
   immediatement recopiee (upsert) dans Supabase — best effort, on ne bloque
   jamais la requete et on tolere les coupures reseau (disjoncteur).
2. Sauvegarde complete : « Sauvegarder maintenant » pousse TOUTE la base et
   enregistre un instantane date dans la table ``backups``. La fonction
   inverse « Restaurer depuis le cloud » reconstruit la base locale.

Configuration par variables d'environnement (avec valeurs par defaut) :

    SUPABASE_URL   URL du projet Supabase
    SUPABASE_KEY   cle publique (« publishable ») du projet
    CAVALLY_CLOUD  "on" (defaut) ou "off" pour desactiver la sauvegarde
    CAVALLY_CLOUD_TIMEOUT  delai max d'une requete, en secondes (defaut 8)
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime

try:  # requests n'est requis que pour la sauvegarde en ligne
    import requests
except Exception:  # pragma: no cover
    requests = None


SUPABASE_URL = (
    os.environ.get("SUPABASE_URL") or "https://bwizsitdyijrezqlixdp.supabase.co"
).rstrip("/")
SUPABASE_KEY = (
    os.environ.get("SUPABASE_KEY")
    or "sb_publishable_U3apjfW4YOFZC4P6iCbZ7A_ef4kO3jM"
)
TIMEOUT = float(os.environ.get("CAVALLY_CLOUD_TIMEOUT") or "8")

# Etat partage (par processus) : dernier succes, derniere erreur, disjoncteur.
_last_ok = None
_last_error = None
_disabled_until = 0.0
_BREAKER_SECONDS = 60

# Etat de la synchronisation automatique locale <-> en ligne.
_sync_lock = threading.Lock()
_sync_running = False
_last_sync = None            # date lisible du dernier cycle termine
_last_sync_ts = 0.0          # horodatage interne (throttle)
_last_backup_ts = 0.0        # dernier instantane envoye automatiquement
SYNC_EVERY = float(os.environ.get("CAVALLY_SYNC_EVERY") or "20")   # 2. synchronisation
BACKUP_EVERY = float(os.environ.get("CAVALLY_BACKUP_EVERY") or "900")  # 15 min

_PAGE = 1000  # taille des pages de lecture
_BATCH = 500  # taille des lots d'ecriture


def _configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_KEY and requests is not None)


def enabled() -> bool:
    """La sauvegarde est-elle active ?"""
    mode = (os.environ.get("CAVALLY_CLOUD") or "on").strip().lower()
    if mode in ("off", "0", "false", "non", "no", "disabled"):
        return False
    if not _configured():
        return False
    return time.time() >= _disabled_until


def status() -> dict:
    """Etat de la sauvegarde (pour l'affichage)."""
    return {
        "configured": _configured(),
        "enabled": enabled(),
        "url": SUPABASE_URL,
        "last_ok": _last_ok,
        "last_error": _last_error,
        "last_sync": _last_sync,
        "breaker": time.time() < _disabled_until,
    }


def _headers(prefer: str | None = None) -> dict:
    h = {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if prefer:
        h["Prefer"] = prefer
    return h


def _request(method: str, path: str, params: dict | None = None,
             json_body=None, prefer: str | None = None):
    """Appel REST a PostgREST. Leve une exception en cas d'erreur."""
    global _last_ok, _last_error, _disabled_until
    url = SUPABASE_URL + "/rest/v1" + path
    try:
        resp = requests.request(
            method, url, headers=_headers(prefer), params=params,
            data=json.dumps(json_body) if json_body is not None else None,
            timeout=TIMEOUT,
        )
        if resp.status_code >= 400:
            raise RuntimeError("HTTP %s: %s" % (resp.status_code, resp.text[:300]))
        _last_ok = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        _disabled_until = 0.0
        return resp
    except Exception as exc:  # noqa
        _last_error = "%s: %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), exc)
        # Coupe la sauvegarde pendant un moment pour ne pas ralentir l'application.
        _disabled_until = time.time() + _BREAKER_SECONDS
        raise


# ---------------------------------------------------------------------------
# Ecritures elementaires
# ---------------------------------------------------------------------------


def _upsert(table: str, rows: list, on_conflict: str):
    if not rows:
        return 0
    total = 0
    for i in range(0, len(rows), _BATCH):
        chunk = rows[i:i + _BATCH]
        _request(
            "POST", "/" + table,
            params={"on_conflict": on_conflict},
            json_body=chunk,
            prefer="resolution=merge-duplicates,return=minimal",
        )
        total += len(chunk)
    return total


def _delete(table: str, params: dict):
    if not params:
        return
    _request("DELETE", "/" + table, params=params, prefer="return=minimal")


def _count(table: str) -> int:
    """Nombre de lignes d'une table (via l'entete Content-Range)."""
    url = SUPABASE_URL + "/rest/v1" + "/" + table
    resp = requests.get(url, headers=_headers("count=exact"),
                        params={"select": "*", "limit": 1}, timeout=TIMEOUT)
    if resp.status_code >= 400:
        raise RuntimeError("HTTP %s: %s" % (resp.status_code, resp.text[:200]))
    cr = resp.headers.get("Content-Range", "")  # ex: 0-0/1234
    if "/" in cr:
        try:
            return int(cr.split("/")[-1])
        except ValueError:
            pass
    return 0


def _select_all(table: str):
    """Lit toute une table, page par page."""
    out = []
    offset = 0
    while True:
        resp = requests.get(
            SUPABASE_URL + "/rest/v1/" + table,
            headers=_headers(),
            params={"select": "*", "limit": _PAGE, "offset": offset,
                    "order": _order_for(table)},
            timeout=TIMEOUT,
        )
        if resp.status_code >= 400:
            raise RuntimeError("HTTP %s: %s" % (resp.status_code, resp.text[:200]))
        page = resp.json()
        out.extend(page)
        if len(page) < _PAGE:
            break
        offset += _PAGE
    return out


def _order_for(table: str) -> str:
    if table == "entries":
        return "lot,row,task,field"
    return "lot,row_num"


# ---------------------------------------------------------------------------
# Miroir temps reel
# ---------------------------------------------------------------------------

def merge_duplicates(table: str, rows: list, conflict: str):
    """Upsert public (utilise par full_push)."""
    _request("POST", "/" + table,
             params={"on_conflict": conflict},
             json_body=rows,
             prefer="resolution=merge-duplicates,return=minimal")


def mirror(entries_upserts=None, entries_deletes=None,
           custom_locals_upserts=None, custom_locals_deletes=None,
           deleted_locals_upserts=None, deleted_locals_deletes=None):
    """Recopie des changements locaux vers Supabase (best effort)."""
    if not enabled():
        return False
    global _last_error
    try:
        if entries_upserts:
            _upsert("entries", entries_upserts, "lot,row,task,field")
        for d in (entries_deletes or []):
            params = {"lot": "eq.%s" % d["lot"], "row": "eq.%s" % int(d["row"])}
            if d.get("task") is not None:
                params["task"] = "eq.%s" % d["task"]
            if d.get("field") is not None:
                params["field"] = "eq.%s" % d["field"]
            _delete("entries", params)
        if custom_locals_upserts:
            _upsert("custom_locals", custom_locals_upserts, "lot,row_num")
        for d in (custom_locals_deletes or []):
            _delete("custom_locals", {"lot": "eq.%s" % d["lot"],
                                      "row_num": "eq.%s" % int(d["row_num"])})
        if deleted_locals_upserts:
            _upsert("deleted_locals", deleted_locals_upserts, "lot,row_num")
        for d in (deleted_locals_deletes or []):
            _delete("deleted_locals", {"lot": "eq.%s" % d["lot"],
                                       "row_num": "eq.%s" % int(d["row_num"])})
        return True
    except Exception as exc:  # noqa
        _last_error = "%s (miroir)" % exc
        return False


# ---------------------------------------------------------------------------
# Sauvegarde / restauration completes
# ---------------------------------------------------------------------------

def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def full_push() -> dict:
    """Pousse toute la base locale vers Supabase + enregistre un instantane."""
    import db  # import paresseux (evite un cycle)

    if not _configured():
        return {"ok": False, "error": "Sauvegarde non configuree."}

    dump = db.dump_all()
    entries = dump["entries"]
    customs = dump["custom_locals"]
    deleted = dump["deleted_locals"]

    try:
        # 1) Miroir complet des cellules (upsert par lots)
        for i in range(0, len(entries), _BATCH):
            _request("POST", "/entries",
                     params={"on_conflict": "lot,row,task,field"},
                     json_body=entries[i:i + _BATCH],
                     prefer="resolution=merge-duplicates,return=minimal")

        # 2) Tables de locaux : ajout / mise a jour (jamais de suppression :
        #    les suppressions voyagent par les pierres tombales).
        _sync_small_table("custom_locals", customs, ("lot", "row_num"))
        _sync_small_table("deleted_locals", deleted, ("lot", "row_num"))

        # 3) Instantane date (copie figee a un instant donne)
        payload = {"entries": entries, "custom_locals": customs,
                   "deleted_locals": deleted}
        _request("POST", "/backups", json_body=[{
            "kind": "full",
            "nb_entries": len(entries),
            "nb_locals": len(customs) + len(deleted),
            "payload": payload,
        }], prefer="return=minimal")

        # 4) Metadonnees de synchronisation
        _request("POST", "/sync_meta",
                 params={"on_conflict": "key"},
                 json_body=[{"key": "last_backup", "value": _now(),
                             "updated_at": _now()}],
                 prefer="resolution=merge-duplicates,return=minimal")

        _truncate_backups(10)
        return {"ok": True, "entries": len(entries), "custom_locals": len(customs),
                "deleted_locals": len(deleted), "at": _now()}
    except Exception as exc:  # noqa
        global _last_error
        _last_error = str(exc)
        return {"ok": False, "error": str(exc)}


def _sync_small_table(table: str, rows: list, key_fields: tuple):
    """Ajoute/actualise les petites tables cloud (sans jamais supprimer).

    Les suppressions ne doivent plus voyager en « delete en masse » : elles
    passent par les pierres tombales (table deleted_locals), seules capables de
    propager une suppression sans effacer par erreur les lignes ajoutees par un
    autre appareil.
    """
    conflict = ",".join(key_fields)
    if rows:
        for i in range(0, len(rows), _BATCH):
            _request("POST", "/" + table,
                     params={"on_conflict": conflict},
                     json_body=rows[i:i + _BATCH],
                     prefer="resolution=merge-duplicates,return=minimal")


def _truncate_backups(keep: int = 10):
    """Ne conserve que les N instantanes les plus recents."""
    try:
        resp = requests.get(
            SUPABASE_URL + "/rest/v1/backups",
            headers=_headers(),
            params={"select": "id", "order": "id.desc", "limit": 200},
            timeout=TIMEOUT,
        )
        if resp.status_code >= 400:
            return
        ids = [r["id"] for r in resp.json()]
        for old in ids[keep:]:
            _delete("backups", {"id": "eq.%s" % int(old)})
    except Exception:
        pass


def pull() -> dict:
    """Lit toute la sauvegarde en ligne."""
    if not _configured():
        raise RuntimeError("Sauvegarde non configuree.")
    return {
        "entries": _select_all("entries"),
        "custom_locals": _select_all("custom_locals"),
        "deleted_locals": _select_all("deleted_locals"),
    }


def restore(mode: str = "replace") -> dict:
    """Reconstruit la base locale depuis Supabase.

    mode='replace' : la base locale est remplacee par la copie en ligne.
    mode='merge'   : la copie en ligne est fusionnee dans la base locale.
    """
    import db

    if not _configured():
        return {"ok": False, "error": "Sauvegarde non configuree."}
    try:
        payload = {
            "entries": _select_all("entries"),
            "custom_locals": _select_all("custom_locals"),
            "deleted_locals": _select_all("deleted_locals"),
        }
        res = db.load_all(payload, replace=(mode != "merge"))
        return {"ok": True, "mode": mode, "restored": res}
    except Exception as exc:  # noqa
        global _last_error
        _last_error = str(exc)
        return {"ok": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# Synchronisation bidirectionnelle (fusion « derniere ecriture gagne »)
#
# La copie en ligne n'est plus seulement une sauvegarde : elle sert de point de
# rendez-vous entre le serveur, les telephones et les ordinateurs. A chaque
# cycle, on lit la copie en ligne, on la fusionne avec les donnees locales
# (la date d'ecriture la plus recente gagne), on reecrit le resultat en local
# et on ne renvoie en ligne que ce qui a change.
# ---------------------------------------------------------------------------

_ENTRY_FIELDS = ("lot", "row", "task", "field", "value", "updated_by", "updated_at")
_CUSTOM_FIELDS = ("lot", "row_num", "designation", "niveau", "created_by", "created_at")
_DELETED_FIELDS = ("lot", "row_num", "deleted_by", "deleted_at")


def _t(v) -> str:
    """Horodatage comparable (format 'AAAA-MM-JJ HH:MM:SS')."""
    return str(v or "").strip()


def _ek(e: dict):
    return (str(e.get("lot")), str(int(e.get("row"))), str(e.get("task")),
            str(e.get("field")))


def _sk(r: dict):
    return (str(r.get("lot")), str(int(r.get("row_num"))))


def _row_key(row: dict, fields) -> tuple:
    return tuple("" if row.get(f) is None else str(row.get(f)) for f in fields)


def _merge(local: dict, remote: dict, tfield: str, fields) -> tuple:
    """Fusionne deux dictionnaires {cle: ligne}. Renvoie (fusion, a_pousser)."""
    merged = {}
    push = []
    for k in set(local) | set(remote):
        l = local.get(k)
        r = remote.get(k)
        if l is None:
            merged[k] = r
            continue
        if r is None:
            merged[k] = l
            push.append(l)
            continue
        if _t(r.get(tfield)) > _t(l.get(tfield)):
            merged[k] = r          # la version en ligne est plus recente
        else:
            merged[k] = l
            if _row_key(l, fields) != _row_key(r, fields):
                push.append(l)      # divergence : on impose la version locale
    return merged, push


def _chunks(rows: list, size: int):
    for i in range(0, len(rows), size):
        yield rows[i:i + size]


def _upsert_rows(table: str, rows: list, conflict: str):
    for chunk in _chunks(rows, _BATCH):
        _request("POST", "/" + table,
                 params={"on_conflict": conflict},
                 json_body=chunk,
                 prefer="resolution=merge-duplicates,return=minimal")


def sync() -> dict:
    """Fusionne la base locale et la copie en ligne dans les deux sens."""
    import db

    global _last_error, _last_sync, _last_sync_ts
    if not _configured():
        return {"ok": False, "error": "Sauvegarde non configuree."}
    try:
        rem_e = {_ek(e): e for e in _select_all("entries")}
        rem_c = {_sk(c): c for c in _select_all("custom_locals")}
        rem_d = {_sk(d): d for d in _select_all("deleted_locals")}
    except Exception as exc:  # noqa
        _last_error = "%s (lecture en ligne)" % exc
        return {"ok": False, "error": str(exc)}

    local = db.dump_all()
    loc_e = {_ek(e): e for e in local["entries"]}
    loc_c = {_sk(c): c for c in local["custom_locals"]}
    loc_d = {_sk(d): d for d in local["deleted_locals"]}

    merged_e, _ = _merge(loc_e, rem_e, "updated_at", _ENTRY_FIELDS)
    merged_c, _ = _merge(loc_c, rem_c, "created_at", _CUSTOM_FIELDS)
    merged_d, _ = _merge(loc_d, rem_d, "deleted_at", _DELETED_FIELDS)

    # Une ligne ne peut pas etre a la fois « ajoutee » et « supprimee » :
    # la date la plus recente tranche.
    drop_c_remote, drop_d_remote = [], []
    for k in set(merged_c) & set(merged_d):
        c, d = merged_c[k], merged_d[k]
        if _t(d.get("deleted_at")) >= _t(c.get("created_at")):
            del merged_c[k]
            drop_c_remote.append(k)
        else:
            del merged_d[k]
            drop_d_remote.append(k)

    # Les cellules des locaux masques/supprimes ne sont pas conservees.
    hidden = set(merged_d.keys())
    for k in list(merged_e):
        if (k[0], k[1]) in hidden:
            del merged_e[k]

    # Filet de securite : on relit la base locale juste avant d'ecrire, au cas
    # ou une saisie serait arrivee pendant la lecture de la copie en ligne.
    local2 = db.dump_all()
    loc_e2 = {_ek(e): e for e in local2["entries"]}
    loc_c2 = {_sk(c): c for c in local2["custom_locals"]}
    loc_d2 = {_sk(d): d for d in local2["deleted_locals"]}
    merged_e, _ = _merge(loc_e2, merged_e, "updated_at", _ENTRY_FIELDS)
    merged_c, _ = _merge(loc_c2, merged_c, "created_at", _CUSTOM_FIELDS)
    merged_d, _ = _merge(loc_d2, merged_d, "deleted_at", _DELETED_FIELDS)
    for k in list(merged_e):
        if (k[0], k[1]) in set(merged_d.keys()):
            del merged_e[k]

    try:
        db.apply_merge(list(merged_e.values()), list(merged_c.values()),
                       list(merged_d.values()))
    except Exception as exc:  # noqa
        _last_error = "%s (ecriture locale)" % exc
        return {"ok": False, "error": str(exc)}

    # Ce qui doit etre renvoye en ligne = tout ce qui differe de la copie lue.
    def _to_push(merged, remote, fields):
        out = []
        for k, r in merged.items():
            if k not in remote or _row_key(r, fields) != _row_key(remote[k], fields):
                out.append(r)
        return out

    push_e = _to_push(merged_e, rem_e, _ENTRY_FIELDS)
    push_c = _to_push(merged_c, rem_c, _CUSTOM_FIELDS)
    push_d = _to_push(merged_d, rem_d, _DELETED_FIELDS)

    pushed = 0
    try:
        if push_e:
            _upsert_rows("entries", push_e, "lot,row,task,field")
            pushed += len(push_e)
        if push_c:
            _upsert_rows("custom_locals", push_c, "lot,row_num")
            pushed += len(push_c)
        if push_d:
            _upsert_rows("deleted_locals", push_d, "lot,row_num")
            pushed += len(push_d)
        for k in drop_c_remote:
            _delete("custom_locals", {"lot": "eq.%s" % k[0], "row_num": "eq.%s" % k[1]})
        for k in drop_d_remote:
            _delete("deleted_locals", {"lot": "eq.%s" % k[0], "row_num": "eq.%s" % k[1]})
    except Exception as exc:  # noqa
        _last_error = "%s (envoi)" % exc
        return {"ok": False, "error": str(exc), "merged": len(merged_e)}

    _last_sync = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    _last_sync_ts = time.time()
    _request_safe_sync_meta()
    return {
        "ok": True, "at": _last_sync,
        "entries": len(merged_e), "custom_locals": len(merged_c),
        "deleted_locals": len(merged_d), "pushed": pushed, "removed": 0,
    }


def _request_safe_sync_meta():
    try:
        _request("POST", "/sync_meta",
                 params={"on_conflict": "key"},
                 json_body=[{"key": "last_sync", "value": _last_sync,
                             "updated_at": datetime.now().isoformat()}],
                 prefer="resolution=merge-duplicates,return=minimal")
    except Exception:
        pass


def maybe_sync(background: bool = True) -> bool:
    """Lance une synchronisation si le delai minimum est ecoule."""
    global _last_sync_ts
    if not enabled():
        return False
    if _sync_running:
        return False
    if time.time() - _last_sync_ts < SYNC_EVERY:
        return False
    # on bloque tout de suite la fenetre : evite que plusieurs requetes
    # simultanees ne lancent plusieurs fils de synchronisation.
    _last_sync_ts = time.time()
    if background:
        threading.Thread(target=_sync_worker, daemon=True).start()
        return True
    _sync_worker()
    return True


def sync_now(snapshot: bool = True) -> dict:
    """Synchronisation immediate, en respectant le verrou (bloquant)."""
    global _sync_running, _last_sync_ts, _last_error
    if not enabled():
        return {"ok": False, "error": "Sauvegarde en ligne indisponible."}
    with _sync_lock:
        if _sync_running:
            return {"ok": False, "error": "Synchronisation deja en cours."}
        _sync_running = True
    try:
        res = sync()
        if res.get("ok") and snapshot and time.time() - _last_backup_ts > BACKUP_EVERY:
            backup()
        return res
    except Exception as exc:  # noqa
        _last_error = "%s (synchronisation)" % exc
        return {"ok": False, "error": str(exc)}
    finally:
        with _sync_lock:
            _sync_running = False
        _last_sync_ts = time.time()


def _sync_worker():
    sync_now(snapshot=True)


def backup() -> dict:
    """Force la creation d'un instantane date en ligne."""
    global _last_backup_ts
    res = full_push()
    if res.get("ok"):
        _last_backup_ts = time.time()
    return res


def cloud_status() -> dict:
    import db

    local = db.count_all()
    st = status()
    st["local"] = local
    cloud = {"entries": None, "custom_locals": None, "deleted_locals": None}
    if enabled():
        try:
            for t in ("entries", "custom_locals", "deleted_locals"):
                cloud[t] = _count(t)
        except Exception as exc:  # noqa
            global _last_error
            _last_error = str(exc)
    st["cloud"] = cloud
    return st


def recent_backups(limit: int = 10):
    """Liste les derniers instantanes (sans le contenu)."""
    if not enabled():
        return []
    try:
        resp = requests.get(
            SUPABASE_URL + "/rest/v1/backups",
            headers=_headers(),
            params={"select": "id,created_at,kind,nb_entries,nb_locals",
                    "order": "id.desc", "limit": limit},
            timeout=TIMEOUT,
        )
        if resp.status_code >= 400:
            raise RuntimeError(resp.text[:200])
        return resp.json()
    except Exception as exc:  # noqa
        global _last_error
        _last_error = str(exc)
        return []
