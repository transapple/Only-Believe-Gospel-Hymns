/* Only Believe Gospel Hymns — offline service worker
   - App shell (page, manifest, icons, Supabase library) is downloaded on every online visit
   - Page opens instantly from the phone, then quietly refreshes itself in the background
   - Images and voice notes from Supabase storage are kept for offline use
   Bump VERSION whenever you want every phone to re-download everything. */
const VERSION = 'v3';
const SHELL = 'obgh-shell-' + VERSION;
const MEDIA = 'obgh-media-v1';
const MEDIA_LIMIT = 400;
const SUPABASE_LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
const SHELL_URLS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', SUPABASE_LIB];

async function precacheShell() {
  const cache = await caches.open(SHELL);
  await Promise.all(SHELL_URLS.map(async (u) => {
    try {
      const req = new Request(u, { cache: 'reload', mode: u.startsWith('http') ? 'cors' : 'same-origin' });
      const res = await fetch(req);
      if (res && res.ok) await cache.put(u, res.clone());
    } catch (e) { /* one missing file must never block the rest */ }
  }));
}

self.addEventListener('install', (e) => { e.waitUntil(precacheShell().then(() => self.skipWaiting())); });

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => (k.startsWith('obgh-shell-') && k !== SHELL) || k.startsWith('only-believe-hymns-')).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trimMedia() {
  const cache = await caches.open(MEDIA);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MEDIA_LIMIT; i++) await cache.delete(keys[i]);
}

// Show the saved copy immediately; refresh it from the network in the background.
async function staleWhileRevalidate(req, cacheName, opts) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, opts);
  const net = fetch(req).then(async (res) => {
    if (res && (res.ok || res.type === 'opaque')) { await cache.put(req, res.clone()); if (cacheName === MEDIA) trimMedia(); }
    return res;
  }).catch(() => null);
  if (cached) { net.catch(() => {}); return cached; }
  const res = await net;
  return res || Response.error();
}

async function rangeFromCache(req, res) {
  const range = req.headers.get('range');
  if (!range || !res || res.status !== 200 || res.type === 'opaque') return res;
  const buf = await res.arrayBuffer();
  const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = m[2] ? Math.min(parseInt(m[2], 10), buf.byteLength - 1) : buf.byteLength - 1;
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg',
               'Content-Range': 'bytes ' + start + '-' + end + '/' + buf.byteLength,
               'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' }
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The app page itself — always openable offline
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const cached = (await cache.match('./index.html')) || (await cache.match('./'));
      const net = fetch(req).then(async (res) => {
        if (res && res.ok) { await cache.put('./index.html', res.clone()); }
        return res;
      }).catch(() => null);
      if (cached) { e.waitUntil(net); return cached; }
      return (await net) || new Response('<h1>Offline</h1><p>Open the app once with internet to download it.</p>',
        { headers: { 'Content-Type': 'text/html' } });
    })());
    return;
  }

  // Supabase JS library (CDN) — cache first
  if (req.url === SUPABASE_LIB) {
    e.respondWith(caches.match(SUPABASE_LIB).then(r => r || fetch(req).then(async (res) => {
      if (res && res.ok) (await caches.open(SHELL)).put(SUPABASE_LIB, res.clone());
      return res;
    })));
    return;
  }

  // Supabase data / realtime / auth — never intercepted (the app keeps its own offline copy)
  if (url.hostname.endsWith('.supabase.co') && !url.pathname.startsWith('/storage/v1/object/')) return;

  // Uploaded pictures and voice notes
  if (url.hostname.endsWith('.supabase.co')) {
    e.respondWith((async () => {
      const res = await staleWhileRevalidate(new Request(req.url, { mode: req.destination === 'audio' ? 'cors' : 'no-cors' }), MEDIA);
      return req.destination === 'audio' || req.headers.get('range') ? rangeFromCache(req, res) : res;
    })());
    return;
  }

  // Same-origin files (icons, manifest, logos…)
  if (url.origin === self.location.origin) {
    e.respondWith(staleWhileRevalidate(req, SHELL, { ignoreSearch: true }));
    return;
  }

  // Any other picture on the web
  if (req.destination === 'image') e.respondWith(staleWhileRevalidate(req, MEDIA));
});

// The page can ask for extra files to be saved (pictures, voice notes) or the shell to be re-downloaded.
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'REFRESH_SHELL') {
    e.waitUntil(precacheShell().then(() => e.source && e.source.postMessage({ type: 'SHELL_READY' })));
  } else if (d.type === 'CACHE_URLS' && Array.isArray(d.urls)) {
    e.waitUntil((async () => {
      const cache = await caches.open(MEDIA);
      let saved = 0;
      for (const u of d.urls) {
        try {
          if (await cache.match(u)) { saved++; continue; }
          const isAudio = /\.(webm|mp3|m4a|ogg|wav|aac)(\?|$)/i.test(u);
          const res = await fetch(new Request(u, { mode: isAudio ? 'cors' : 'no-cors' }));
          if (res && (res.ok || res.type === 'opaque')) { await cache.put(new Request(u, { mode: isAudio ? 'cors' : 'no-cors' }), res); saved++; }
        } catch (err) { /* skip, try again next sync */ }
      }
      await trimMedia();
      if (e.source) e.source.postMessage({ type: 'MEDIA_SAVED', saved, total: d.urls.length });
    })());
  }
});
