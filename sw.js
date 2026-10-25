// Single service worker for the app (registered by coi-serviceworker.js).
// 1) Adds COOP/COEP/CORP headers to every same-origin response, so the page is crossOriginIsolated
//    (SharedArrayBuffer -> multi-threaded WASM) even on static hosts like GitHub Pages.
// 2) Offline cache: everything the app fetches is cached; the full asset list is also precached in the background.
// All paths are relative to this file, so it works under any subpath (e.g. /ar-names/).
const CACHE = 'ar-names-v7';
const ASSETS = [
  './', 'index.html', 'coi-serviceworker.js', 'app.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/main.js', 'js/ort.js', 'js/detector.js', 'js/embedder.js', 'js/labels3d.js', 'js/tracker.js', 'js/geometry.js', 'js/db.js', 'js/server.js',
  'vendor/ort/ort.wasm.min.mjs', 'vendor/ort/ort-wasm-simd-threaded.mjs', 'vendor/ort/ort-wasm-simd-threaded.wasm',
  'vendor/three/three.module.js', 'vendor/three/three.core.js',
  'vendor/three/addons/loaders/FontLoader.js', 'vendor/three/addons/geometries/TextGeometry.js',
  'models/yunet.onnx', 'models/sface.onnx', 'fonts/dejavu_sans_bold_greek.typeface.json',
];
// Precache only what is not cached yet (runs in the background; never blocks activation).
async function precache() {
  const c = await caches.open(CACHE);
  await Promise.all(ASSETS.map(async (a) => {
    const url = new URL(a, self.registration.scope).href;
    if (await c.match(url, { ignoreSearch: true })) return;
    try { const r = await fetch(url, { cache: 'reload' }); if (r.ok) await c.put(url, r); } catch (_) {}
  }));
}
// Install/activate immediately so the page can be reloaded under control (and isolated) right away.
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith('ar-names-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
  precache(); // background, not awaited
});
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'precache') e.waitUntil(precache());
  // 'coepCredentialless' / 'deregister' messages from coi-serviceworker.js are ignored (always require-corp).
});
function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin'); // as upstream coi-serviceworker; lets the browser load manifest icons
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return isolate(hit);
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') { const copy = res.clone(); e.waitUntil(c.put(req, copy)); }
      return isolate(res);
    } catch (err) {
      // offline navigation fallback
      if (req.mode === 'navigate') { const idx = await c.match(new URL('index.html', self.registration.scope).href); if (idx) return isolate(idx); }
      throw err;
    }
  })());
});
