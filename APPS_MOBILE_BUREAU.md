# Applications CAVALLY — Android (APK), iPhone (IPA) et Windows (.exe / .msi)

Ces applications sont **autonomes** : elles ne s'ouvrent **pas** sur le site en
ligne. Elles contiennent leur propre interface et **enregistrent les données
directement sur l'appareil**. Elles s'installent comme de vraies applications
(icône, écran de démarrage, fenêtre dédiée) et **fonctionnent entièrement
hors-ligne** : la saisie continue sans réseau, l'**import/export Excel** se fait
sur l'appareil, et une **sauvegarde en ligne** (Supabase) est envoyée
automatiquement dès le retour de la connexion.

## Ce qui est fourni

| Application | Dossier | Ce qu'on obtient |
|---|---|---|
| **Android** | `apps/mobile/android` | fichier **`.apk`** installable directement |
| **iPhone / iPad** | `apps/mobile/ios` | fichier **`.ipa`** (à re-signer avec iLoader/AltStore/Sideloadly) |
| **Windows** | `apps/desktop` | installateur **`.exe`**, paquet **`.msi`** et version **portable `.exe`** |
| **macOS / Linux** | `apps/desktop` | `.dmg` / `.AppImage` + `.deb` (en option) |

Le code de l'application embarquée est **commun** aux trois plateformes :
`apps/mobile/www/` (interface, données, import/export Excel). Windows le réutilise
tel quel au moment de la compilation.

> ✅ **Les trois compilations ont été testées avec succès** et produisent :
> - **Android** : `app-debug.apk` (installable directement sur téléphone/tablette)
> - **iPhone** : `CAVALLY-unsigned.ipa`
> - **Windows** : `CAVALLY Setup 1.0.0.exe` (installateur), `CAVALLY 1.0.0.msi`
>   et `CAVALLY 1.0.0.exe` (portable, sans installation)

---

## ⭐ Récupérer les applications déjà compilées

1. Ouvrez le dépôt **`Ghoster-pac/cavally-plateforme`** sur GitHub.
2. Onglet **Actions**.
3. Cliquez sur la compilation voulue (**Build Android (APK)**,
   **Build Windows (.exe / .msi)** ou **Build iOS (IPA non signé)**).
4. En bas de la page, section **Artifacts**, cliquez pour télécharger :
   - `cavally-android-apk` → contient `app-debug.apk`
   - `cavally-windows` → contient les `.exe` et `.msi`
   - `cavally-ios-ipa` → contient `CAVALLY-unsigned.ipa`
5. Pour déclencher une nouvelle compilation : **Run workflow** (bouton à droite).

### Installation sur les appareils

- **Android** : transférez `app-debug.apk` sur le téléphone, ouvrez-le, et
  autorisez « Installer depuis cette source » si demandé.
- **iPhone / iPad** : le `.ipa` n'est pas signé ; installez-le avec
  **iLoader**, **AltStore** ou **Sideloadly** (qui le re-signent pour votre
  appareil). Avec un identifiant Apple gratuit, la signature doit être refaite
  environ tous les 7 jours.
- **Windows** : exécutez `CAVALLY Setup 1.0.0.exe` (ou le `.msi`). La version
  portable `.exe` se lance sans installation.

---

## ⭐ Méthode recommandée : GitHub Actions (aucun outil à installer)

C'est la façon la plus simple : GitHub construit les applications **gratuitement
sur ses propres serveurs** et vous récupérez juste les fichiers finaux.

1. Mettez le code à jour sur GitHub (dépôt `Ghoster-pac/cavally-plateforme`).
2. Ouvrez l'onglet **Actions** du dépôt.
3. Choisissez le workflow voulu :
   - **Build Android (APK)**
   - **Build Windows (.exe / .msi)**
   - **Build iOS (IPA non signé)**
4. Cliquez **Run workflow** (bouton à droite).
5. Attendez la fin (quelques minutes), puis téléchargez l'artefact
   (« cavally-android-apk », « cavally-windows », « cavally-ios-ipa ») en bas de
   la page du workflow.

> Les workflows se déclenchent aussi automatiquement à chaque modification des
> dossiers `apps/`.

---

## Où sont stockées les données

- **Sur l'appareil** : toutes les saisies, les locaux ajoutés/supprimés et les
  commentaires sont enregistrés localement (aucun compte, aucun serveur requis).
- **En ligne (sauvegarde)** : à chaque modification, l'application envoie aussi
  la donnée vers **Supabase** dès qu'un réseau est disponible. Le bouton
  **Sauvegarde → « ☁ Sauvegarder maintenant »** crée un instantané complet.
  Le bouton **Restaurer** récupère la sauvegarde en ligne (utile après une
  réinstallation ou un changement de téléphone).
- **Excel** : l'**import** lit un fichier `.xlsx` et l'**export** régénère le
  classeur complet (mêmes onglets, mises en forme, listes et graphique).

> Pour récupérer des données déjà saisies sur la plateforme web : ouvrez la page
> **Sauvegarde** du site, cliquez **« ☁ Sauvegarder maintenant »**, puis dans
> l'application, page **Sauvegarde → Restaurer**. Sinon, exportez le fichier
> Excel depuis le site et importez-le dans l'application.

---

## Réglage de l'adresse (facultatif)

Les applications autonomes n'ont **pas** besoin d'adresse : elles chargent leur
propre interface embarquée.

- **Mobile** : rien à régler (`apps/mobile/capacitor.config.json` n'a plus de
  `server.url`).
- **Bureau** : si vous voulez forcer l'ouverture du **site en ligne** au lieu de
  l'interface embarquée, définissez la variable d'environnement `CAVALLY_URL`
  (voir `apps/desktop/main.js`). Par défaut, l'application de bureau est
  autonome.

---

## Compilation locale (optionnelle, pour développeurs)

### Android (APK)
Prérequis : **Android Studio** (ou JDK 17 + Android SDK).

```bash
cd apps/mobile
npm install
npx cap sync android
cd android
./gradlew assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
```
Ou ouvrez le dossier `apps/mobile/android` dans Android Studio → **Build APK**.

### iPhone / iPad (IPA)
Prérequis : un **Mac** avec **Xcode** et **CocoaPods**.

```bash
cd apps/mobile
npm install
npx cap sync ios
cd ios/App
pod install
open App.xcworkspace           # puis Product ▸ Archive dans Xcode
```
> Une installation sur un iPhone réel nécessite une signature Apple
> (compte développeur Apple, ou outils comme **AltStore / Sideloadly** pour un
> `.ipa` non signé).

### Windows (.exe / .msi)
Prérequis : **Node.js 20+** (sur Windows).

```bash
cd apps/desktop
npm install
npm run dist:win               # → dossier dist/ (.exe, .msi, portable)
```

### Linux / macOS (bureau)
```bash
cd apps/desktop
npm run dist:linux             # AppImage + .deb
npm run dist:mac               # .dmg (à compiler sur un Mac)
```

---

## Régénérer les icônes et écrans de démarrage

Les images sources sont dans `apps/mobile/assets/` (1024×1024 pour l'icône,
2732×2732 pour l'écran de démarrage). Après les avoir modifiées :

```bash
cd apps/mobile
npx @capacitor/assets generate --android --ios
```

---

## Signature pour les magasins (facultatif)

- **Android (Play Store)** : créez un *keystore* et compilez en `release`
  (`./gradlew assembleRelease` avec `signingConfig`).
- **iPhone (App Store)** : compte **Apple Developer** (99 $/an), signature et
  `Export IPA` depuis Xcode.
- **Windows** : la signature de code (certificat) évite l'avertissement
  SmartScreen ; l'application fonctionne sans, avec un simple message au premier
  lancement.

---

## Comment ça marche (architecture)

Les applications embarquent une **application autonome** (dossier
`apps/mobile/www/`) : interface (HTML/CSS/JS), **gabarit Excel** et **moteur
d'export** (JSZip) + **d'import** (SheetJS). Une coque native l'exécute :
Android WebView / iOS WKWebView (Capacitor) ou Chromium (Electron pour Windows).

- Les **données** sont conservées sur l'appareil (`localStorage`).
- La **sauvegarde en ligne** parle directement à **Supabase** (REST) depuis
  l'application ; une **file d'attente** conserve les changements tant qu'il n'y
  a pas de réseau, puis les envoie automatiquement (disjoncteur de 60 s en cas
  d'erreur).
- L'**export Excel** patche le gabarit d'origine (XML) pour préserver la mise en
  forme, les listes déroulantes et le graphique ; l'**import** relit le classeur
  et fusionne les cellules.

Le dossier `apps/desktop` réutilise **exactement** le même `www` : au moment de
la compilation, le workflow copie `apps/mobile/www` dans `apps/desktop/www`.
