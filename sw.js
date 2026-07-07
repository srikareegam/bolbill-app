const CACHE_NAME = "bolbill-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./join.html",
  "./history.html",
  "./summary.html",
  "./settings.html",
  "./style.css",
  "./data.js",
  "./firebase-config.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  // Never cache Firestore/Google API calls — always go live for data.
  if (event.request.url.includes("firestore.googleapis.com") ||
      event.request.url.includes("googleapis.com")) return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      }).catch(() => cached);
    })
  );
});
