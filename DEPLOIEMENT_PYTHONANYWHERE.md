# Déploiement gratuit sur PythonAnywhere

Guide pas à pas pour mettre en ligne la plateforme CAVALLY et la partager via un
lien (aucun compte à créer pour les utilisateurs : ils ouvrent juste l'URL).

- **Coût** : 0 € (offre gratuite « Beginner »).
- **Carte bancaire** : non requise.
- **Persistance** : oui — la base `data/cavally.db` est conservée dans ton espace.
- **Résultat** : `https://VOTRE_UTILISATEUR.pythonanywhere.com`

---

## 1. Créer le compte

1. Va sur <https://www.pythonanywhere.com/> → **Pricing & signup** → **Create a Beginner account**.
2. Choisis un **nom d'utilisateur** : il deviendra ton adresse
   (`VOTRE_UTILISATEUR.pythonanywhere.com`). Note-le bien.

## 2. Récupérer le code

Ouvre une console : **Dashboard → Consoles → Bash** (nouvelle console).

### Option A — depuis GitHub (recommandé)

```bash
git clone https://github.com/VOTRE_COMPTE/cavally-plateforme.git
cd cavally-plateforme
```

### Option B — envoi direct (sans GitHub)

1. **Files → Upload a file** : téléverse l'archive `cavally-plateforme.zip`
   (fournie à côté du projet).
2. Dans la console Bash :

```bash
cd ~
unzip cavally-plateforme.zip
cd cavally-plateforme
```

## 3. Créer l'environnement Python et installer

Toujours dans la console Bash :

```bash
cd ~/cavally-plateforme

# Vérifie les versions de Python disponibles
ls /usr/bin/python3.*

# Crée un environnement virtuel (adapte la version si besoin)
mkvirtualenv --python=/usr/bin/python3.13 cavally

# Installe les dépendances
pip install -r requirements.txt
```

> Si `python3.13` n'existe pas sur ton compte, utilise `python3.10` ou `python3.11`.

## 4. Créer l'application web

1. **Dashboard → Web → Add a new web app**.
2. **Manual configuration** (ne pas choisir « Flask » : on configure nous-mêmes).
3. Choisis la **même version de Python** que celle du virtualenv (ex. Python 3.13).

## 5. Renseigner les chemins

Dans l'onglet **Web**, section **Code** :

| Champ | Valeur |
|---|---|
| **Source code** | `/home/VOTRE_UTILISATEUR/cavally-plateforme` |
| **Working directory** | `/home/VOTRE_UTILISATEUR/cavally-plateforme` |
| **Virtualenv** | `/home/VOTRE_UTILISATEUR/.virtualenvs/cavally` |

Section **Static files** (recommandé, plus rapide) — ajoute une ligne :

| URL | Directory |
|---|---|
| `/static/` | `/home/VOTRE_UTILISATEUR/cavally-plateforme/static` |

## 6. Configurer le fichier WSGI

1. Toujours dans **Web**, clique sur le lien du **fichier WSGI**
   (ex. `/var/www/VOTRE_UTILISATEUR_pythonanywhere_com_wsgi.py`).
2. **Efface tout** son contenu et colle celui de `pythonanywhere_wsgi.py`
   (dans le projet). **Remplace** `VOTRE_UTILISATEUR` par ton vrai nom.
3. **Save**.

## 7. Activer

1. Clique sur le gros bouton vert **Reload**.
2. Ouvre <https://VOTRE_UTILISATEUR.pythonanywhere.com>.

Au premier chargement, la base est automatiquement créée et initialisée depuis
le modèle Excel. Tu arrives sur le **Tableau de bord**.

C'est le lien à partager : n'importe qui peut saisir des données sans compte.

---

## Mettre à jour le code plus tard

```bash
cd ~/cavally-plateforme
git pull
```

Puis clique sur **Reload** dans l'onglet Web.

## Sauvegarder / restaurer les données

- **Sauvegarde** : onglet **Files** → `cavally-plateforme/data/` →
  télécharge `cavally.db` (c'est toute la base).
- **Restauration** : renvoie le fichier `cavally.db` au même endroit, puis Reload.
- **Remise à zéro** : supprime `data/cavally.db` (et `cavally.db-wal`/`-shm`
  s'ils existent) via l'onglet Files, puis Reload → réinitialisation depuis le modèle.

## Réglages utiles (variables d'environnement)

Le fichier WSGI définit déjà `CAVALLY_JOURNAL=DELETE` (important sur
PythonAnywhere à cause du système de fichiers réseau). Tu peux en ajouter
d'autres dans `os.environ.setdefault(...)` :

| Variable | Rôle |
|---|---|
| `CAVALLY_SECRET` | clé de session Flask (mets une chaîne aléatoire) |
| `CAVALLY_DB` | emplacement de la base (par défaut `data/cavally.db`) |
| `CAVALLY_JOURNAL` | `DELETE` (défaut ici) ou `WAL` |

## Limites de l'offre gratuite (à connaître)

- **~100 secondes de CPU par jour.** Une utilisation normale (saisie, consultation,
  ouverture du fichier Excel) consomme très peu. Un usage intensif ou de nombreux
  gros exports peuvent épuiser le quota : l'app se met alors en pause jusqu'au
  lendemain. Pour un usage pro intensif, passer à l'offre à 5 $/mois lève la limite.
- **Sous-domaine `pythonanywhere.com`** (pas de domaine personnalisé en gratuit).
- Espace disque : largement suffisant (le projet fait ~1,3 Mo + la base).

## Dépannage

| Symptôme | Cause / solution |
|---|---|
| Erreur 502 / page blanche | Onglet Web → **Error log**. Le plus souvent : mauvais chemin dans le WSGI ou virtualenv non sélectionné. |
| `ModuleNotFoundError: flask` | Le virtualenv n'est pas renseigné dans l'onglet Web, ou `pip install` fait hors virtualenv (vérifie avec `workon cavally`). |
| `database is locked` | Vérifie que `CAVALLY_JOURNAL=DELETE` est bien présent dans le WSGI. |
| Le style ne s'affiche pas | Vérifie la ligne « Static files » ou recharge avec Ctrl+F5. |
| Modifs invisibles après `git pull` | Il faut cliquer sur **Reload**. |
