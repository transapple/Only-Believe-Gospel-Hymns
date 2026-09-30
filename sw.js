/* Only Believe Gospel Hymns service worker
   - Required by Chrome/Edge/Samsung Internet before they allow a real install.
   - Keeps a copy of the app so it still opens with no signal. */

const CACHE_PREFIX = "only-believe-hymns-";
const CACHE = CACHE_PREFIX + "v6";
// Permanent home for update pictures. Different prefix on purpose, so a version bump above
// never deletes it and downloaded images stay on the phone.
const MEDIA_CACHE = "obgh-media-v1";
// Only the admin's update pictures (public, each file has its own unique name so it never goes stale).
const MEDIA_RE = /^https:\/\/[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/public\/media\/updates\//;
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(new Request(u, { cache: "reload" })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        // Only touch our own caches; other sites on the same host share Cache Storage.
        keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Update pictures: saved once, then served from the phone (works with no signal).
  // Database/API calls (rest, auth, realtime) are NOT covered by this rule and are never cached.
  if (MEDIA_RE.test(req.url)) {
    event.respondWith(
      caches.open(MEDIA_CACHE).then((cache) =>
        cache.match(req.url).then((hit) =>
          hit || fetch(new Request(req.url, { mode: "cors", credentials: "omit" }))
            .then((res) => { if (res && res.ok) cache.put(req.url, res.clone()).catch(() => {}); return res; })
            .catch(() => fetch(req))
        )
      )
    );
    return;
  }

  // Database calls, CDNs, fonts, etc. go straight to the network, never cached here.
  if (url.origin !== self.location.origin) return;

  // Opening the app: network first (always the latest version), cached copy if offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("./index.html", copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  // Icons, manifest and other same-site files: cached copy first, refreshed in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
