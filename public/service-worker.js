const CACHE = "meetingnote-shell-v24";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/auth.js",
  "/auth.css",
  "/plans.js",
  "/assistant.css",
  "/shell.css",
  "/preferences.css",
  "/preferences.js",
  "/ask.js",
  "/captures.js",
  "/in-app-browser.js",
  "/vendor/webp/encoder.js",
  "/vendor/webp/webp_enc.js",
  "/vendor/webp/webp_enc.wasm",
  "/transcription.js",
  "/zip.js",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // Live data, and the private calendar feed, never go into the offline cache.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/cal/")) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match("/index.html")))
  );
});
