# Applications CAVALLY — Android (APK), iPhone (IPA) et Windows (.exe / .msi)

Ce dossier contient les **applications natives** qui entourent la plateforme de
suivi. Elles s'installent comme de vraies applications (icône, écran de
démarrage, fenêtre dédiée) et **fonctionnent hors-ligne** : la saisie continue
sans réseau, puis se **synchronise automatiquement** dès le retour de la
connexion (grâce au mode hors-ligne de la plateforme).

## Ce qui est fourni

| Application | Dossier | Ce qu'on obtient |
|---|---|---|
| **Android** | `apps/mobile/android` | fichier **`.apk`** installable directement |
| **iPhone / iPad** | `apps/mobile/ios` | fichier **`.ipa`** (à re-signer avec AltStore/Sideloadly) |
| **Windows** | `apps/desktop` | installateur **`.exe`**, paquet **`.msi`** et version **portable `.exe`** |
| **macOS / Linux** | `apps/desktop` | `.dmg` / `.AppImage` + `.deb` (en option) |

Toutes pointent vers la plateforme en ligne (une seule adresse à changer, voir
plus bas). Le bureau peut aussi être compilé pour Linux et macOS.

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
  **AltStore** ou **Sideloadly** (qui le re-signent pour votre appareil).
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

## Réglage de l'adresse de la plateforme

L'adresse est définie à **un seul endroit par application** :

- **Mobile** : `apps/mobile/capacitor.config.json` → `server.url`
- **Bureau** : `apps/desktop/main.js` → `APP_URL` (ou variable d'environnement
  `CAVALLY_URL`)

```json
"server": { "url": "https://GhosterPacman.pythonanywhere.com" }
```

Remplacez par votre adresse si elle change, puis relancez une compilation.

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

Les applications sont des **coques natives** autour de la plateforme web : une
fenêtre native (Android WebView, WKWebView iOS, Chromium Electron) qui charge la
plateforme en ligne. Le **mode hors-ligne** et la **synchronisation automatique**
sont gérés par la plateforme elle-même (service worker + file d'attente locale),
donc les trois applications en bénéficient automatiquement, sans code spécifique.
