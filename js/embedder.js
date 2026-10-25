// SFace (OpenCV Zoo, Apache-2.0) face embedding via onnxruntime-web (WASM SIMD).
import { ort, session } from './ort.js';
import { TEMPLATE_112, similarity, l2norm } from './geometry.js';

export class Embedder {
  constructor() {
    this.size = 112;
    const C = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(112, 112) : Object.assign(document.createElement('canvas'), { width: 112, height: 112 });
    this.canvas = C;
    this.ctx = C.getContext('2d', { willReadFrequently: true });
    this.input = new Float32Array(3 * 112 * 112);
    this.busy = false;
  }
  async init() {
    // fp16-stored weights, cast to fp32 at load (int8 is ~6x slower in WASM)
    this.session = await session('models/sface.onnx');
    this.inName = this.session.inputNames[0];
    this.outName = this.session.outputNames[0];
    // warm-up
    await this.run(this.input);
  }
  // Synchronously crop + align a face from a video/image/canvas source. Returns Float32Array input.
  // kps: 5 points in source pixels (YuNet order).
  crop(source, kps, w, h) {
    const src = kps;
    const [a, b, tx, ty] = similarity(src, TEMPLATE_112);
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 112, 112);
    ctx.setTransform(a, b, -b, a, tx, ty);
    ctx.drawImage(source, 0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const d = ctx.getImageData(0, 0, 112, 112).data;
    const n = 112 * 112;
    const t = new Float32Array(3 * n);
    for (let i = 0, j = 0; i < n; i++, j += 4) { // RGB, 0..255, NCHW
      t[i] = d[j]; t[i + n] = d[j + 1]; t[i + 2 * n] = d[j + 2];
    }
    return t;
  }
  thumb(size = 96) { // data URL of the last aligned crop
    const c = document.createElement('canvas'); c.width = c.height = size;
    c.getContext('2d').drawImage(this.canvas, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.8);
  }
  async run(tensorData) {
    const feeds = { [this.inName]: new ort.Tensor('float32', tensorData, [1, 3, 112, 112]) };
    const out = await this.session.run(feeds);
    return l2norm(out[this.outName].data);
  }
}
