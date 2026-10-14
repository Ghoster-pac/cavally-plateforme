/* ===========================================================================
   CAVALLY — application de bureau (Electron)
   Encapsule la plateforme de suivi dans une vraie fenêtre d'application.
   Le mode hors-ligne et la synchronisation sont assurés par la plateforme
   elle-même (service worker + file d'attente locale dans le navigateur).
   =========================================================================== */
const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");

// URL de la plateforme (modifiable via la variable d'environnement CAVALLY_URL).
const APP_URL = process.env.CAVALLY_URL || "https://GhosterPacman.pythonanywhere.com";
let APP_HOST = "";
try { APP_HOST = new URL(APP_URL).host; } catch (e) { APP_HOST = ""; }

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 480,
    backgroundColor: "#0b6b6f",
    title: "CAVALLY — Suivi Travaux",
    icon: path.join(__dirname, "build", "icon.png"),
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Les liens externes s'ouvrent dans le navigateur par défaut.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(APP_URL) || (APP_HOST && url.includes(APP_HOST))) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Si la plateforme distante est injoignable (hors-ligne au 1er lancement),
  // on affiche une page locale explicative.
  mainWindow.loadURL(APP_URL).catch(() => {
    mainWindow.loadFile("offline.html").catch(() => {});
  });
}

function buildMenu() {
  const template = [
    {
      label: "Fichier",
      submenu: [{ role: "quit", label: "Quitter" }],
    },
    {
      label: "Édition",
      submenu: [
        { role: "undo", label: "Annuler" },
        { role: "redo", label: "Rétablir" },
        { type: "separator" },
        { role: "cut", label: "Couper" },
        { role: "copy", label: "Copier" },
        { role: "paste", label: "Coller" },
        { role: "selectAll", label: "Tout sélectionner" },
      ],
    },
    {
      label: "Affichage",
      submenu: [
        { role: "reload", label: "Recharger" },
        { role: "resetZoom", label: "Zoom normal" },
        { role: "zoomIn", label: "Agrandir" },
        { role: "zoomOut", label: "Réduire" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Plein écran" },
      ],
    },
    {
      label: "Aide",
      submenu: [
        { label: "Ouvrir dans le navigateur", click: () => shell.openExternal(APP_URL) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Une seule instance à la fois.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    buildMenu();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
