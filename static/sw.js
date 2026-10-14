/* ===========================================================================
   Service worker CAVALLY — rend la plateforme installable et utilisable
   hors-ligne. Les saisies faites sans réseau sont mises en file d'attente par
   l'application (localStorage) puis envoyées automatiquement au retour du
   réseau par app.js. Ici on garantit surtout que l'application s'ouvre et que
   les dernières données connues restent consultables.
   =========================================================================== */

const VERSION = "cavally-v1";
const SHELL = [
  "/",
  "/static/app.css",
  "/static/app.js",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
  "/static/icons/icon-maskable-512.png",
  "/static/icons/apple-touch-icon.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      // addAll échoue si une seule ressource manque : on tolère les échecs.
      Promise.all(SHELL.map((url) => cache.add(url).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isStatic(url) {
  return url.pathname.startsWith("/static/") || url.pathname === "/manifest.webmanifest";
}
function isApi(url) {
  return url.pathname.startsWith("/api/");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // POST/PUT/DELETE : réseau, géré par l'app

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // ressources externes

  // 1) Ressources statiques : cache d'abord (rapide), mise à jour en arrière-plan.
  if (isStatic(url)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // 2) Appels API (lecture) : réseau d'abord, sinon dernière version connue.
  if (isApi(url)) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // 3) Pages : réseau d'abord, sinon la page déjà visitée (mise en cache).
  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok && res.type === "basic") {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() =>
      caches.match(req).then((cached) => cached || caches.match("/"))
    )
  );
});
