const CACHE_NAME = "bolbill-v3";
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

// Network-first: always try to get the latest version of a file first.
// Only fall back to the last-saved cached copy if there's no internet at all.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (event.request.url.includes("googleapis.com")) return; // Firestore always goes straight to network
  event.respondWith(
    fetch(event.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(event.request))
  );
});
