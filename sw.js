// Single service worker for the app (registered by coi-serviceworker.js).
// 1) Adds COOP/COEP/CORP headers to every same-origin response, so the page is crossOriginIsolated
//    (SharedArrayBuffer -> multi-threaded WASM) even on static hosts like GitHub Pages.
// 2) Offline cache: everything the app fetches is cached; the full asset list is also precached in the background.
// 3) v25: the app's OWN code (page, js/, css, manifest, icons) is NETWORK-FIRST (revalidated, ~3.5 s timeout, then cache),
//    so an update is visible on the very first open. Heavy files (vendor/, models/, fonts/, models3d/, wasm) stay cache-first.
// All paths are relative to this file, so it works under any subpath (e.g. /ar-names/).
const CACHE = 'ar-names-v25';   // keep in sync with APP_VERSION in js/main.js
// 3D models (models3d/) are NEVER precached: each is cached on first use, in its own cache that survives app updates.
const MODELS_CACHE = 'ar-names-models-1';
const ASSETS = [
  './', 'index.html', 'coi-serviceworker.js', 'app.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png', 'favicon.ico',
  'js/main.js', 'js/ort.js', 'js/detector.js', 'js/embedder.js', 'js/labels3d.js', 'js/tracker.js', 'js/geometry.js', 'js/db.js', 'js/server.js', 'js/objects3d.js', 'js/chime.js', 'js/pings.js',
  'vendor/ort/ort.wasm.min.mjs', 'vendor/ort/ort-wasm-simd-threaded.mjs', 'vendor/ort/ort-wasm-simd-threaded.wasm',
  'vendor/three/three.module.js', 'vendor/three/three.core.js',
  'vendor/three/addons/loaders/FontLoader.js', 'vendor/three/addons/geometries/TextGeometry.js',
  'vendor/three/addons/loaders/GLTFLoader.js', 'vendor/three/addons/utils/SkeletonUtils.js', 'vendor/three/addons/utils/BufferGeometryUtils.js',
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
  e.waitUntil((async () => {
    const ks = await caches.keys();
    const isUpdate = ks.some((k) => /^ar-names-v\d+$/.test(k) && k !== CACHE);   // an older app version was installed
    await Promise.all(ks.filter((k) => k.startsWith('ar-names-') && k !== CACHE && k !== MODELS_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    // tell open pages which version is now active (the page decides if/when to reload; it never interrupts the user)
    if (isUpdate) for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'updated', version: CACHE });
  })());
  precache(); // background, not awaited
});
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'precache') e.waitUntil(precache());
  if (e.data && e.data.type === 'version' && e.source) e.source.postMessage({ type: 'version', version: CACHE });
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
// Heavy, rarely changing files: cache-first. Everything else in scope (our own code) is network-first.
const HEAVY = /\/(vendor|models|models3d|fonts)\/|\.(wasm|onnx|glb|gltf)$/;
const NET_TIMEOUT = 3500;
// Pages whose navigation fell back to the cache (offline / slow) also get their js from the cache -> no mixed versions.
const offlineClients = new Set();
const cacheKey = (u) => { const x = new URL(u); return x.origin + x.pathname; };
async function networkFirst(e, req, c) {
  const url = new URL(req.url);
  const nav = req.mode === 'navigate';
  const key = cacheKey(req.url);
  const cached = () => c.match(key, { ignoreSearch: true }).then((r) => r || (nav ? c.match(new URL('index.html', self.registration.scope).href) : null));
  if (!nav && e.clientId && offlineClients.has(e.clientId)) { const hit = await cached(); if (hit) return isolate(hit); }
  const net = fetch(url.href, { cache: 'no-cache', credentials: 'same-origin', redirect: nav ? 'manual' : 'follow' }).then((res) => {
    if (res.ok && res.type === 'basic') {
      const copy = res.clone(), idx = nav && url.pathname.endsWith('/') ? res.clone() : null;
      e.waitUntil(Promise.all([c.put(key, copy), idx && c.put(new URL('index.html', self.registration.scope).href, idx)]).catch(() => {}));
    }
    return res;
  });
  e.waitUntil(net.then(() => {}, () => {}));   // let a slow download finish and refresh the cache even after a timeout
  const mark = (r) => { if (nav && e.resultingClientId) offlineClients.add(e.resultingClientId); return r; };
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, NET_TIMEOUT, 'timeout'); });
  try {
    const first = await Promise.race([net, timeout]);
    if (first !== 'timeout') { clearTimeout(timer); if (first.type === 'opaqueredirect') return first; return isolate(first); }
    const hit = await cached();
    if (hit) return isolate(mark(hit));
    return isolate(await net);                 // nothing cached yet: keep waiting for the network
  } catch (err) {
    clearTimeout(timer);
    const hit = await cached();
    if (hit) return isolate(mark(hit));        // offline
    throw err;
  }
}
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  const path = new URL(req.url).pathname;
  if (!req.url.startsWith(self.registration.scope)) return;
  if (!HEAVY.test(path)) { e.respondWith(caches.open(CACHE).then((c) => networkFirst(e, req, c))); return; }
  e.respondWith((async () => {
    const c = await caches.open(/\/models3d\//.test(path) ? MODELS_CACHE : CACHE);
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return isolate(hit);
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') { const copy = res.clone(); e.waitUntil(c.put(req, copy)); }
    return isolate(res);
  })());
});
