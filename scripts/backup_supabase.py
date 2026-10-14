#!/usr/bin/env python3
"""Sauvegarde complete de la base locale vers Supabase (base en ligne).

A lancer par une tache planifiee (PythonAnywhere > Onglet « Tasks », cron, ...).

Exemple (PythonAnywhere) :
    python3 /home/UTILISATEUR/cavally-plateforme/scripts/backup_supabase.py

Variables d'environnement reconnues : SUPABASE_URL, SUPABASE_KEY,
CAVALLY_CLOUD, CAVALLY_CLOUD_TIMEOUT (voir cloud.py).
"""
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)
os.chdir(BASE)

import cloud  # noqa: E402


def main() -> int:
    if not cloud.status()["configured"]:
        print("Sauvegarde non configuree : renseignez SUPABASE_URL et SUPABASE_KEY.")
        return 1
    res = cloud.full_push()
    if res.get("ok"):
        print("Sauvegarde OK : %s cellule(s), %s local(aux) — instantane %s"
              % (res["entries"], res["custom_locals"] + res["deleted_locals"], res["at"]))
        return 0
    print("ECHEC de la sauvegarde :", res.get("error"))
    return 1


if __name__ == "__main__":
    sys.exit(main())
