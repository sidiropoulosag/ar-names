// YuNet face detector (OpenCV Zoo, MIT) via onnxruntime-web.
// Detects many faces incl. small/far and turned faces; returns box + 5 landmarks per face.
import { ort, session } from './ort.js';
import { poseFrom5 } from './geometry.js';

const STRIDES = [8, 16, 32];

export class Detector {
  constructor() {
    this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(32, 32) : document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.scoreThr = 0.6; this.nmsThr = 0.3; this.maxFaces = 12;
    this.delegate = 'wasm';
  }
  async init(maxFaces = 12) {
    this.maxFaces = maxFaces;
    this.session = await session('models/yunet.onnx');
    this.delegate = `wasm×${ort.env.wasm.numThreads}`;
    // warm-up
    const t = new ort.Tensor('float32', new Float32Array(3 * 288 * 512), [1, 3, 288, 512]);
    await this.session.run({ input: t });
  }
  // source: video / image / bitmap. long: model input long side (multiple of 32).
  async detect(source, sw, sh, long = 512) {
    const s = long / Math.max(sw, sh);
    const W = Math.ceil(sw * s / 32) * 32, H = Math.ceil(sh * s / 32) * 32;
    const c = this.canvas; if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = this.ctx;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(source, 0, 0, sw * s, sh * s);
    const d = ctx.getImageData(0, 0, W, H).data;
    const n = W * H;
    if (!this.buf || this.buf.length !== 3 * n) this.buf = new Float32Array(3 * n);
    const x = this.buf;
    for (let i = 0, j = 0; i < n; i++, j += 4) { x[i] = d[j + 2]; x[i + n] = d[j + 1]; x[i + 2 * n] = d[j]; } // BGR
    const out = await this.session.run({ input: new ort.Tensor('float32', x, [1, 3, H, W]) });
    const thr2 = this.scoreThr * this.scoreThr;
    const cand = [];
    for (const st of STRIDES) {
      const cols = W / st, rows = H / st;
      const cls = out['cls_' + st].data, obj = out['obj_' + st].data, bb = out['bbox_' + st].data, kp = out['kps_' + st].data;
      for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
        const i = r * cols + q;
        const c0 = Math.min(1, Math.max(0, cls[i])), o0 = Math.min(1, Math.max(0, obj[i]));
        const sc2 = c0 * o0; if (sc2 < thr2) continue;
        const cx = (q + bb[i * 4]) * st, cy = (r + bb[i * 4 + 1]) * st;
        const w = Math.exp(bb[i * 4 + 2]) * st, h = Math.exp(bb[i * 4 + 3]) * st;
        const kps = [];
        for (let k = 0; k < 5; k++) kps.push([(kp[i * 10 + 2 * k] + q) * st / s, (kp[i * 10 + 2 * k + 1] + r) * st / s]);
        cand.push({ score: Math.sqrt(sc2), x0: (cx - w / 2) / s, y0: (cy - h / 2) / s, x1: (cx + w / 2) / s, y1: (cy + h / 2) / s, kps });
      }
    }
    cand.sort((a, b) => b.score - a.score);
    const faces = [];
    for (const c of cand) {
      if (faces.length >= this.maxFaces) break;
      if (faces.some((f) => iouPx(f, c) > this.nmsThr)) continue;
      faces.push(c);
    }
    for (const f of faces) {
      f.box = { x0: f.x0 / sw, y0: f.y0 / sh, x1: f.x1 / sw, y1: f.y1 / sh };
      f.wpx = f.x1 - f.x0;
      f.pose = poseFrom5(f.kps);
    }
    return { faces, inW: W, inH: H };
  }
}
function iouPx(a, b) {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy, u = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return u > 0 ? inter / u : 0;
}
