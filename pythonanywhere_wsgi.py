"""Fichier WSGI pour PythonAnywhere.

MODE D'EMPLOI
-------------
1. Remplace VOTRE_UTILISATEUR ci-dessous par ton nom d'utilisateur
   PythonAnywhere (celui de l'URL https://VOTRE_UTILISATEUR.pythonanywhere.com).
2. Copie TOUT ce fichier dans l'editeur WSGI de PythonAnywhere
   (onglet Web -> section "Code" -> lien du fichier WSGI), en remplacant
   le contenu existant, puis clique sur "Reload".
"""

import os
import sys

# ---------------------------------------------------------------------------
# A ADAPTER : dossier du projet (chemin absolu sur PythonAnywhere)
# ---------------------------------------------------------------------------
PROJECT_DIR = "/home/VOTRE_UTILISATEUR/cavally-plateforme"
# ---------------------------------------------------------------------------

if PROJECT_DIR not in sys.path:
    sys.path.insert(0, PROJECT_DIR)

# Le systeme de fichiers de PythonAnywhere est en reseau : on evite le mode
# WAL de SQLite (source de "database is locked") et on utilise DELETE.
os.environ.setdefault("CAVALLY_JOURNAL", "DELETE")

# Optionnel : change la cle de session Flask (met une valeur aleatoire).
# os.environ.setdefault("CAVALLY_SECRET", "change-moi-en-chaine-aleatoire")

# L'application Flask est exposee sous le nom "application".
from app import app as application  # noqa: E402
