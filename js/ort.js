// Shared onnxruntime-web (WASM SIMD, multi-threaded when crossOriginIsolated).
// v26: threads only when the browser really can (SharedArrayBuffer + shared WebAssembly.Memory). If a threaded
// start fails on this device (e.g. some iOS Safari builds), main.js first reloads once with threads; if it fails
// again it sets ORT_1T_KEY and the app runs single-threaded (slower, but it works) for 7 days.
import * as ort from '../vendor/ort/ort.wasm.min.mjs';
const base = new URL('../', import.meta.url);
export const ORT_1T_KEY = 'ar-names-ort-1thread';
export const IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
function canThreads() {
  try {
    if (!self.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined') return false;
    const m = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    return m.buffer instanceof SharedArrayBuffer;
  } catch (_) { return false; }
}
let forced1 = false;
// '1' = for good; a timestamp = set automatically after a failed threaded start -> retried with threads after 7 days
try { const v = localStorage.getItem(ORT_1T_KEY); forced1 = v === '1' || (+v > 0 && Date.now() - +v < 7 * 864e5); } catch (_) {}
const hc = navigator.hardwareConcurrency || 2;
// iOS: at most 3 workers (WebKit memory limits / thermal), elsewhere up to 4
export const threadsOk = canThreads() && !forced1;
ort.env.wasm.wasmPaths = new URL('vendor/ort/', base).href;
ort.env.wasm.numThreads = threadsOk ? Math.max(1, Math.min(IOS ? 3 : 4, hc - 1)) : 1;
ort.env.logLevel = 'error';
export const ortInfo = { threads: ort.env.wasm.numThreads, threadsOk, forced1, ios: IOS, hc };
export { ort, base };
export async function session(path) {
  const buf = await (await fetch(new URL(path, base).href)).arrayBuffer();
  const p = ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  if (ort.env.wasm.numThreads <= 1) return p;
  // v26: a threaded start that never finishes (seen as a silent worker error) must not leave the app stuck on «Φόρτωση…»
  let tm; const hang = new Promise((_, rej) => { tm = setTimeout(() => rej(new Error('wasm threads timeout')), 60000); });
  try { return await Promise.race([p, hang]); } finally { clearTimeout(tm); }
}
