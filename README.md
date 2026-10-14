# Plateforme de suivi des travaux — Projet CAVALLY

Application web pour **saisir à plusieurs l'avancement des travaux** (par lot, par niveau et par local),
puis **générer le fichier Excel officiel** identique au modèle d'origine.

- Saisie en ligne par plusieurs personnes (aucun compte : accès par le lien partagé)
- Import d'un classeur Excel déjà rempli pour fusionner les données
- Export d'un classeur strictement conforme au modèle : mises en forme, listes
  déroulantes, **graphique du tableau de bord** et onglets de synthèse conservés

## Modèle géré

Le classeur source `files/cavally_template.xlsx` contient :

| Feuille | Rôle |
|---|---|
| TABLEAU DE BORD | synthèse par lot + graphique |
| AVANCEMENT PAR NIVEAU | avancement par niveau et par lot |
| AVANCEMENT PBS | Plomberie — 385 locaux × 20 tâches |
| AVANCEMENT CVC | CVCD — 385 locaux × 24 tâches |
| AVCT CFO | Électricité — 385 locaux × 25 tâches |
| AVANCEMENT CFA-SSI | CFA / SSI — 385 locaux × 25 tâches |
| RECAP GENERAL | récapitulatif des lots |

Pour chaque local et chaque tâche : **Avancement (%)**, **Statut**, **Observation**.
Statuts : Non démarré · En cours · Terminé · Bloqué · Non conforme · À vérifier.

## Démarrage rapide (local)

```bash
cd cavally-plateforme
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 app.py
# ouvrir http://localhost:5000
```

Au premier lancement, la base `data/cavally.db` est créée et initialisée à partir du modèle.

## Utilisation

1. En haut à droite, indiquez votre **nom** (mémorisé dans le navigateur, attaché aux modifications).
2. **Tableau de bord** : vue d'ensemble, statuts par lot, activité récente.
3. **Saisie par tâche** (recommandé) : un lot → une tâche → la liste des locaux.
   Le « remplissage groupé » applique une valeur/statut à toutes les lignes affichées (filtrées par niveau).
4. **Saisie par local** : toutes les tâches d'un local + commentaire général.
5. **Gérer les locaux** : sur la page d'un lot, ajoutez un **local personnalisé**
   (désignation + niveau) ; sur la page d'un local, **modifiez** sa désignation/son
   niveau ou **supprimez-le** (les locaux d'origine sont masqués, pas effacés du
   modèle Excel).
6. **Importer** : déposez un classeur rempli pour fusionner.
7. **Exporter** : téléchargez le classeur complet, prêt à diffuser.

Les champs sont enregistrés automatiquement (≈ 0,5 s après la dernière frappe).

### Interface

- **Responsive** : l'interface s'adapte au téléphone, à la tablette et à
  l'ordinateur. Sur petit écran, les tableaux se transforment automatiquement en
  cartes lisibles et le menu devient un bouton ☰.
- **Thème clair / sombre** : bouton 🌙 / ☀️ en haut à droite ; par défaut, le
  thème suit la préférence du système.
- **Impression** propre des tableaux (les boutons et menus sont masqués).

### Application installable + mode hors-ligne (PWA)

La plateforme est une **PWA** : elle s'installe comme une application sur tous les
appareils, sans magasin d'applications.

- **Android (Chrome)** : ⋮ → « Installer l'application ».
- **iPhone / iPad (Safari)** : Partager → « Sur l'écran d'accueil ».
- **Windows / macOS / Linux (Chrome / Edge)** : icône « Installer » dans la barre
  d'adresse.

**Hors-ligne** : sans réseau, la saisie continue. Les modifications sont stockées
sur l'appareil (file d'attente locale) puis **synchronisées automatiquement dès le
retour du réseau**. Un voyant en haut à droite indique l'état
(● en ligne · ● hors ligne · ⟳ synchronisation) et le nombre de saisies en attente.

Fichiers concernés : `static/manifest.webmanifest` (manifeste),
`static/sw.js` (service worker : cache de l'interface et des dernières données),
`static/app.js` (file d'attente et synchronisation).

### Applications natives (Android, iPhone, Windows)

En plus de la PWA, le dépôt contient de **vraies applications installables** :

- **Android** → fichier `.apk`
- **iPhone / iPad** → fichier `.ipa`
- **Windows** → installateur `.exe`, paquet `.msi`, version portable

Elles se compilent **gratuitement via GitHub Actions** (onglet *Actions* du
dépôt), sans installer d'outil. Guide complet :
**[APPS_MOBILE_BUREAU.md](APPS_MOBILE_BUREAU.md)**.

## Déploiement en ligne

> **Recommandé pour un hébergement 100 % gratuit et durable :**
> **[PythonAnywhere](DEPLOIEMENT_PYTHONANYWHERE.md)** — gratuit à vie, sans carte
> bancaire, et les données (SQLite) sont conservées. Guide pas à pas complet ici.

### Option A — PythonAnywhere (gratuit, données persistantes) ⭐

Voir **[DEPLOIEMENT_PYTHONANYWHERE.md](DEPLOIEMENT_PYTHONANYWHERE.md)**.

### Option B — Docker (Render, Railway, Fly.io, VPS…)

```bash
docker build -t cavally .
docker run -p 8080:8080 -v $PWD/data:/data cavally
```

Pour que les données survivent aux redémarrages, il faut **monter un volume
persistant** sur le dossier de la base (`/data`).

⚠️ **Render en plan gratuit n'accepte PAS les disques persistants** : l'app
fonctionne, mais la base est réinitialisée à chaque veille/redéploiement. Pour un
usage réel sur Render, il faut soit un plan payant (disque), soit une base
externe. Sur **Fly.io**, un volume gratuit est disponible pour la persistance.

Variables d'environnement utiles :

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` | port d'écoute | 5000 (dev) / 8080 (docker) |
| `CAVALLY_DB` | chemin de la base SQLite | `data/cavally.db` |
| `CAVALLY_TEMPLATE` | chemin du modèle xlsx | `files/cavally_template.xlsx` |
| `CAVALLY_SECRET` | clé de session Flask | valeur interne |

> Important : montez un volume persistant sur le dossier de la base, sinon les
> données sont perdues à chaque redéploiement.

## Architecture

```
app.py              application Flask (pages + API)
db.py               accès SQLite, agrégations, import
cloud.py            sauvegarde en ligne (miroir Supabase / PostgreSQL)
excel_engine.py     lecture du modèle, export par patch XML, import
templates/          interface (Jinja2)
static/             styles + JavaScript
files/              modèle Excel de référence
data/               base de données et structure (générées)
supabase/schema.sql schéma des tables de sauvegarde en ligne
scripts/            tâches planifiées (sauvegarde complète)
```

### Pourquoi un « patch XML » pour l'export ?

Les bibliothèques classiques réécrivent le fichier et **perdent le graphique**.
Ici, l'export part du fichier d'origine et remplace uniquement le contenu des
cellules : styles, listes déroulantes, fusions, graphique et formules des
synthèses sont préservés à l'identique. Les valeurs en cache des formules sont
retirées pour forcer un recalcul propre à l'ouverture (Excel **et** LibreOffice).

## Sauvegarde

La base est un simple fichier SQLite : copiez `data/cavally.db` pour sauvegarder.

### Sauvegarde en ligne (Supabase / PostgreSQL) ☁

En plus du fichier local, chaque saisie est recopiée dans une **seconde base en
ligne** (Supabase). La page **Sauvegarde** de la plateforme permet de :

- voir l'état (dernière sauvegarde, volumes local/en ligne) ;
- **Sauvegarder maintenant** (copie complète + instantané daté) ;
- **Restaurer depuis le cloud** (remplacement ou fusion).

Guide de mise en place : **[SAUVEGARDE_SUPABASE.md](SAUVEGARDE_SUPABASE.md)**.

Variables d'environnement :

| Variable | Rôle | Défaut |
|---|---|---|
| `SUPABASE_URL` | URL du projet Supabase | projet CAVALLY |
| `SUPABASE_KEY` | clé publique (« publishable ») | clé CAVALLY |
| `CAVALLY_CLOUD` | `on` / `off` (désactiver) | `on` |
| `CAVALLY_CLOUD_TIMEOUT` | délai max d'une requête (s) | `8` |

> La sauvegarde est **best effort** : si le réseau ou Supabase est indisponible,
> la plateforme continue de fonctionner normalement (elle réessaie plus tard).

## Remise à zéro

```bash
rm data/cavally.db*
# relancer l'application : réinitialisation depuis le modèle
```
