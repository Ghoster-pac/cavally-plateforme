"""Plateforme de suivi de chantier CAVALLY - application web."""
from __future__ import annotations

import io
import os
import tempfile
from datetime import datetime

from flask import (Flask, jsonify, render_template, request, send_file,
                   redirect, url_for, flash)

import db
import excel_engine as E

app = Flask(__name__)
app.secret_key = os.environ.get("CAVALLY_SECRET", "cavally-suivi-2026")
app.config["MAX_CONTENT_LENGTH"] = 40 * 1024 * 1024

STATUS_LIST = db.STATUS_LIST

db.init_db()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def current_user():
    if request.method == "POST":
        if request.is_json:
            return (request.get_json(silent=True) or {}).get("user") or "Anonyme"
        return (request.form.get("user") or request.headers.get("X-User") or "Anonyme")
    return request.args.get("user") or "Anonyme"


def structure():
    return db.get_structure()


def lot_or_404(key):
    lot = db.lot_by_key(structure(), key)
    if not lot:
        from flask import abort
        abort(404)
    return lot


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@app.route("/")
def home():
    summary = db.build_summary()
    return render_template("dashboard.html", summary=summary, activity=db.recent_edits(20),
                           nav="home")


@app.route("/lot/<key>")
def lot_page(key):
    lot = lot_or_404(key)
    summary = db.build_summary()
    lot_sum = next(l for l in summary["lots"] if l["key"] == key)
    return render_template("lot.html", lot=lot, lot_sum=lot_sum, nav="lot")


@app.route("/lot/<key>/task/<task_id>")
def task_page(key, task_id):
    lot = lot_or_404(key)
    task = next((t for t in lot["tasks"] if t["id"] == task_id), None)
    if not task:
        from flask import abort
        abort(404)
    return render_template("task.html", lot=lot, task=task, statuses=STATUS_LIST, nav="lot")


@app.route("/lot/<key>/local/<int:row>")
def local_page(key, row):
    lot = lot_or_404(key)
    r = next((x for x in lot["rows"] if x["row"] == row), None)
    if not r:
        from flask import abort
        abort(404)
    return render_template("local.html", lot=lot, local=r, statuses=STATUS_LIST, nav="lot")


@app.route("/import", methods=["GET", "POST"])
def import_page():
    if request.method == "POST":
        f = request.files.get("file")
        if not f or not f.filename:
            flash("Aucun fichier selectionne.", "error")
            return redirect(url_for("import_page"))
        tmp = tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False)
        f.save(tmp.name)
        tmp.close()
        try:
            parsed = E.parse_import(tmp.name, structure())
            n = db.import_cells(parsed, structure(), current_user())
            flash(f"Import reussi : {n} cellule(s) mise(s) a jour.", "ok")
        except Exception as exc:  # noqa
            flash(f"Erreur pendant l'import : {exc}", "error")
        finally:
            os.unlink(tmp.name)
        return redirect(url_for("home"))
    return render_template("import.html", nav="import")


@app.route("/export")
def export_page():
    summary = db.build_summary()
    return render_template("export.html", summary=summary, nav="export")


@app.route("/export/download", methods=["POST"])
def export_download():
    data = db.all_data_for_export()
    blob = E.build_export(db.TEMPLATE, structure(), data)
    name = "SUIVI TRAVAUX CAVALLY - %s.xlsx" % datetime.now().strftime("%d%m%Y")
    return send_file(io.BytesIO(blob), as_attachment=True, download_name=name,
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.route("/help")
def help_page():
    return render_template("help.html", nav="help")


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

@app.route("/api/summary")
def api_summary():
    return jsonify(db.build_summary())


@app.route("/api/activity")
def api_activity():
    return jsonify(db.recent_edits(int(request.args.get("limit", 40))))


@app.route("/api/lot/<key>")
def api_lot(key):
    return jsonify(lot_or_404(key))


@app.route("/api/lot/<key>/task/<task_id>")
def api_task(key, task_id):
    lot = lot_or_404(key)
    vals = db.get_lot_values(key)
    task = next((t for t in lot["tasks"] if t["id"] == task_id), None)
    if not task:
        return jsonify({"error": "tache inconnue"}), 404
    rows = []
    for r in lot["rows"]:
        d = (vals.get(r["row"], {}) or {}).get(task_id, {}) or {}
        rows.append({
            "row": r["row"], "niveau": r["niveau"], "designation": r["designation"],
            "av": d.get("av", ""), "st": d.get("st", "Non démarré"), "obs": d.get("obs", ""),
        })
    return jsonify({"lot": {"key": lot["key"], "label": lot["label"]},
                    "task": task, "levels": lot["levels"], "rows": rows})


@app.route("/api/lot/<key>/local/<int:row>")
def api_local(key, row):
    lot = lot_or_404(key)
    vals = db.get_lot_values(key)
    rd = vals.get(row, {}) or {}
    tasks = []
    for t in lot["tasks"]:
        d = rd.get(t["id"], {}) or {}
        tasks.append({"id": t["id"], "label": t["label"], "col": t["col"],
                      "av": d.get("av", ""), "st": d.get("st", "Non démarré"),
                      "obs": d.get("obs", "")})
    comment = (rd.get("__global__", {}) or {}).get("comment", "")
    return jsonify({"lot": {"key": lot["key"], "label": lot["label"]},
                    "tasks": tasks, "comment": comment})


@app.route("/api/save", methods=["POST"])
def api_save():
    body = request.get_json(force=True, silent=True) or {}
    updates = body.get("updates") or []
    if not updates:
        return jsonify({"saved": 0})
    user = body.get("user") or "Anonyme"
    n = db.save_cells(updates, user)
    return jsonify({"saved": n})


@app.route("/api/reset", methods=["POST"])
def api_reset():
    body = request.get_json(force=True, silent=True) or {}
    if body.get("confirm") != "RESET":
        return jsonify({"error": "confirmation requise"}), 400
    db.forgot(seed_clear=True)
    return jsonify({"ok": True})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("FLASK_DEBUG") == "1")
