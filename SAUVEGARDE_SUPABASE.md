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

- **État** : dernière synchronisation, dernière sauvegarde réussie, volumes
  (local vs en ligne).
- **Synchroniser maintenant** : force tout de suite un cycle de fusion
  locale ↔ en ligne (les saisies des autres appareils sont récupérées, les
  vôtres sont envoyées).
- **Nouvel instantané** : envoie toute la base + enregistre un
  **instantané daté** (les 10 derniers sont conservés).
- **Restaurer depuis le cloud** :
  - *Remplacer* : le serveur reprend exactement la copie en ligne (saisir
    `RESTORE` pour confirmer) ;
  - *Fusionner* : met à jour sans rien supprimer.

Tout cela est **automatique** : la plateforme synchronise avant chaque requête
(au plus une fois toutes les ~20 s), enregistre un instantané daté toutes les
~15 min, et le navigateur vérifie les nouveautés toutes les ~30 s (la page se
rafraîchit si un autre appareil a saisi quelque chose).

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
- **Synchronisation bidirectionnelle** : chaque appareil lit et fusionne la copie en ligne.
  Les saisies les plus récentes sont toujours préservées. Un import de fichier ne
  remplit que les **cases vides** (mode « Compléter » par défaut) ; le mode
  « Mettre à jour » permet de remplacer les valeurs déjà saisies.
- La sauvegarde/restauration est **automatique** : synchronisation au premier
  lancement, toutes les ~15 s, au retour en avant-plan (site + application), après
  import/saisie, et un cycle toutes les ~20 s côté serveur. Un **instantané daté**
  est enregistré périodiquement.
- **Fusion « dernière écriture gagne »** : chaque ligne porte un horodatage
  (`updated_at`, `created_at`, `deleted_at`) au format `AAAA-MM-JJ HH:MM:SS`,
  directement comparable. À chaque cycle, l'appareil lit la copie en ligne, garde
  la version la plus récente pour chaque clé, réécrit le résultat en local puis ne
  renvoie en ligne que ce qui différait de la copie lue.
- **Pierres tombales** : une saisie effacée n'est pas supprimée en ligne mais
  réécrite avec une valeur vide horodatée ; un local supprimé laisse une ligne
  dans `deleted_locals`. C'est ce qui permet à une suppression de se propager sans
  effacer, au passage, les lignes ajoutées par un autre appareil (l'ancien
  « delete en masse » a été retiré pour cette raison).
- Aucune donnée n'est supprimée automatiquement en ligne : les envois sont des
  *upserts*, jamais des `DELETE` massifs.

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
