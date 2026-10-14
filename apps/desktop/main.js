/* ===========================================================================
   CAVALLY — application de bureau (Electron)
   Application AUTONOME : l'interface, les données et l'import/export Excel
   sont embarqués (dossier « www »). Aucun site web n'est nécessaire.
   Une sauvegarde en ligne (Supabase) est faite automatiquement par
   l'application lorsqu'un réseau est disponible.
   =========================================================================== */
const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");

// Si CAVALLY_URL est défini, on charge cette adresse (mode « site en ligne »).
const REMOTE_URL = process.env.CAVALLY_URL || "";

const WWW_DIR = path.join(__dirname, "www");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ico": "image/x-icon",
};

// Petit serveur local : sert le dossier « www » (indispensable pour que
// fetch() et le service worker fonctionnent comme dans un navigateur).
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let rel = decodeURIComponent(req.url.split("?")[0]);
      if (rel === "/" || rel === "") rel = "/index.html";
      const full = path.join(WWW_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
      if (!full.startsWith(WWW_DIR)) { res.writeHead(403); res.end(); return; }
      fs.readFile(full, (err, data) => {
        if (err) { res.writeHead(404); res.end("Introuvable"); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

let mainWindow = null;
let localServer = null;

async function createWindow() {
  let target;
  if (REMOTE_URL) {
    target = REMOTE_URL;
  } else {
    localServer = await startServer();
    target = "http://127.0.0.1:" + localServer.address().port + "/index.html";
  }

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
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadURL(target).catch(() => {
    mainWindow.loadFile("offline.html").catch(() => {});
  });
}

function buildMenu() {
  const template = [
    { label: "Fichier", submenu: [{ role: "quit", label: "Quitter" }] },
    {
      label: "Édition",
      submenu: [
        { role: "undo", label: "Annuler" }, { role: "redo", label: "Rétablir" },
        { type: "separator" },
        { role: "cut", label: "Couper" }, { role: "copy", label: "Copier" },
        { role: "paste", label: "Coller" }, { role: "selectAll", label: "Tout sélectionner" },
      ],
    },
    {
      label: "Affichage",
      submenu: [
        { role: "reload", label: "Recharger" }, { role: "resetZoom", label: "Zoom normal" },
        { role: "zoomIn", label: "Agrandir" }, { role: "zoomOut", label: "Réduire" },
        { type: "separator" }, { role: "togglefullscreen", label: "Plein écran" },
      ],
    },
    {
      label: "Aide",
      submenu: REMOTE_URL
        ? [{ label: "Ouvrir dans le navigateur", click: () => shell.openExternal(REMOTE_URL) }]
        : [{ label: "Application autonome (hors-ligne)", enabled: false }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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

  app.whenReady().then(async () => {
    await createWindow();
    buildMenu();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("will-quit", () => { if (localServer) localServer.close(); });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
