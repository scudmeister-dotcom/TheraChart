/* TheraChart service worker — caches the app shell so it opens instantly
   (and offline) once installed to a phone's home screen. API calls always
   go to the network; clinical data itself lives in the store/server. */

const CACHE = "therachart-v28";
const SHELL = [
  "./", "./index.html", "./styles.css",
  "./parser.js", "./insights.js", "./clinical.js", "./validate.js", "./store.js", "./app.js", "./sync.js",
  "./boot.js",

  "./assets/fonts/fonts.css", "./assets/fonts/figtree-latin.woff2", "./assets/fonts/sora-latin.woff2",
  "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return; // network only
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // cache only good same-origin responses — never let a 404/500 or a
        // third-party response poison the offline app shell
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("./index.html")))
  );
});
