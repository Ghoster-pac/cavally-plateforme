# Sauvegarde en ligne — Supabase / PostgreSQL

La plateforme enregistre les données dans **deux bases** :

1. la base locale `data/cavally.db` (SQLite) — utilisée par l'application ;
2. une **seconde base en ligne** [Supabase](https://supabase.com) (PostgreSQL) —
   copie de sauvegarde, accessible même si le serveur est perdu.

La copie se fait **au fil de l'eau** (à chaque saisie) et peut être **forcée**
(copie complète) depuis la page **Sauvegarde**.

---

## 1. Créer les tables (une seule fois)

1. Ouvrez votre projet Supabase : <https://bwizsitdyijrezqlixdp.supabase.co>.
2. Menu de gauche → **SQL Editor** → **New query**.
3. Copiez-collez tout le contenu du fichier
   [`supabase/schema.sql`](supabase/schema.sql) puis cliquez **Run**.

Cela crée les tables `entries`, `custom_locals`, `deleted_locals`, `sync_meta`
et `backups`, avec les droits nécessaires à la clé publique.

> Pour repartir de zéro : relancez simplement le script (il est réexécutable sans
> risque, tout est en `if not exists`).

## 2. Renseigner les identifiants

Les valeurs du projet CAVALLY sont **pré-remplies** dans `cloud.py` (URL +
clé publique). Pour utiliser un autre projet, définissez les variables
d'environnement :

| Variable | Exemple |
|---|---|
| `SUPABASE_URL` | `https://xxxxxxxx.supabase.co` |
| `SUPABASE_KEY` | `sb_publishable_...` ou la clé `anon` |
| `CAVALLY_CLOUD` | `on` (défaut) / `off` |
| `CAVALLY_CLOUD_TIMEOUT` | `8` (secondes) |

Sur PythonAnywhere, ajoutez-les dans le fichier WSGI (voir
[DEPLOIEMENT_PYTHONANYWHERE.md](DEPLOIEMENT_PYTHONANYWHERE.md)) ou dans le fichier
`.env` de votre choix.

## 3. Utiliser la page « Sauvegarde »

Onglet **Sauvegarde** de la plateforme :

- **État** : dernière sauvegarde réussie, volumes (local vs en ligne).
- **Sauvegarder maintenant** : envoie toute la base + enregistre un
  **instantané daté** (les 10 derniers sont conservés).
- **Restaurer depuis le cloud** :
  - *Remplacer* : le serveur reprend exactement la copie en ligne (saisir
    `RESTORE` pour confirmer) ;
  - **Fusionner** : met à jour sans rien supprimer.

## 3 bis. Sauvegarde automatique périodique (recommandé)

Un script est fourni : `scripts/backup_supabase.py`.

**PythonAnywhere** → onglet **Tasks** → créez une tâche quotidienne :

```
python3 /home/VOTRE_UTILISATEUR/cavally-plateforme/scripts/backup_supabase.py
```

(Le miroir temps réel fonctionne déjà sans cela ; la tâche force une copie
complète régulière et un instantané daté.)

## 3. Restaurer en cas de perte du serveur

Sur un serveur neuf :

```bash
python3 scripts/backup_supabase.py   # vérifie l'accès
```

puis, dans la plateforme, page **Sauvegarde** → **Restaurer depuis le cloud** →
mode **Remplacer**. Toutes les données sont reconstruites depuis Supabase.

---

## Fonctionnement technique

- `cloud.py` appelle l'API REST de Supabase (PostgREST) avec la clé publique.
- **Miroir** : à chaque écriture locale, `db.py` pousse la ou les cellules
  modifiées (upsert) — appel *best effort*, jamais bloquant.
- **Disjoncteur** : après une erreur réseau, les envois sont suspendus ~60 s puis
  repris automatiquement (la saisie reste instantanée).
- **Copie complète** : la page *Sauvegarde* (ou la tâche planifiée) pousse toute
  la base et enregistre un instantané JSON dans la table `backups` (10 derniers
  conservés).

## Sécurité

La plateforme est **ouverte** (partage par lien, sans compte). La base de
sauvegarde utilise donc la clé **publique** et des politiques d'accès ouvertes :
qui a la clé peut lire/écrire cette base. Elle ne contient que l'avancement des
travaux (aucune donnée personnelle sensible).

Pour restreindre : utilisez une clé **secrète** (`sb_secret_...`) côté serveur
(variable `SUPABASE_KEY`) et durcissez les politiques RLS dans `schema.sql`.

## Dépannage

| Symptôme | Cause / solution |
|---|---|
| Erreur `PGRST205 ... Could not find the table` | Le script `supabase/schema.sql` n'a pas encore été exécuté dans le SQL Editor. |
| « Sauvegarde momentanément suspendue… » | Erreur réseau ou clé invalide : la plateforme réessaie automatiquement. |
| Colonnes « En ligne » à `—` | Supabase injoignable : la saisie reste possible, la copie reprendra. |
