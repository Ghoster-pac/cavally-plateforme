# Déploiement gratuit sur Fly.io (via le dashboard)

Fly.io permet d'héberger cette app avec un **volume persistant** (base SQLite)
gratuitement dans le cadre de l'allocation free. L'app tourne même si ton
ordinateur est éteint.

## 1. Préparer les fichiers
Tu as déjà `fly.toml` et `Dockerfile` dans le dossier `cavally-plateforme/`.

Crée une archive ZIP à téléverser si besoin :
```bash
cd /home/ghoster
zip -r cavally-plateforme.zip cavally-plateforme
```

## 2. Créer un compte Fly.io
1. Va sur https://fly.io/
2. Crée un compte (authentification GitHub/Google/mail)
3. À la première connexion, Fly te demandera parfois une **carte bancaire** pour
   activer l'allocation gratuite. Elle n'est pas débitée sauf dépassement.

## 3. Déployer via le dashboard (simple)

1. Connecte-toi sur https://fly.io/dashboard
2. **New app** → **Create app**
3. Donne un nom unique (ex. `cavally-suivi-tonnom`) ou laisse Fly en générer un
4. Choisis la région la plus proche (ex. Paris `cdg`)
5. Sous **Deployment method**, choisis **Upload a zip file** (ou **GitHub** si
   tu pousses le repo)
6. Téléverse `cavally-plateforme.zip`
7. Fly va builder l'image Docker et déployer

## 4. Créer le volume persistant (OBLIGATOIRE pour garder les données)

1. Ouvre ton app dans le dashboard → onglet **Volumes**
2. **Create volume** → nom `cavally_data` (correspond à `source` dans fly.toml)
3. Région identique à l'app
4. Taille 1GB suffit largement
5. Créer

`fly.toml` monte déjà `/data` sur ce volume, donc la base `cavally.db` y sera
conservée entre redémarrages/redéploiements.

## 5. Ouvrir l'app
Une fois déployé, Fly affiche l'URL : `https://ton-nom-app.fly.dev`
C'est le lien à partager. Au premier chargement, la DB se crée depuis le modèle.

## 6. Mettre à jour après modification

- **Via GitHub** : push sur le repo → Fly détecte et redéploie
- **Via ZIP** : re-téléverse l'archive sur le même app

## Notes importantes
- `auto_stop_machines = true` économise les crédits gratuits (mise en veille
  après inactivité) ; au prochain accès ça se réveille (quelques secondes)
- `CAVALLY_JOURNAL=DELETE` est utilisé (compatible avec montage réseau/volume)
- Si jamais tu changes le nom du volume, mets-le à jour dans `fly.toml`
