// Shared onnxruntime-web (WASM SIMD, multi-threaded when crossOriginIsolated).
import * as ort from '../vendor/ort/ort.wasm.min.mjs';
const base = new URL('../', import.meta.url);
ort.env.wasm.wasmPaths = new URL('vendor/ort/', base).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
ort.env.logLevel = 'error';
export { ort, base };
export async function session(path) {
  const buf = await (await fetch(new URL(path, base).href)).arrayBuffer();
  return ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
}
