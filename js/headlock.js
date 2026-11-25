// v47: cheap on-device head lock. When YuNet loses a recognised face (profile, back of
// the head, looking down), follow the last head region with an adaptive template + a
// colour histogram, and keep the name on that person. No extra model, no server.
// If we are not sure (weak match, two people crossing), fade the label rather than guess.

export const HOLD_MS = 8000;   // drop after this long without a face or a good follow
export const FADE_MS = 1200;

const TW = 32, TH = 32;
const H_BINS = 16, S_BINS = 8;

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

export function boxCenter(b) { return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }; }

export function boxDist(a, b) {
  const ca = boxCenter(a), cb = boxCenter(b);
  const sa = Math.hypot(a.x1 - a.x0, a.y1 - a.y0) || 1e-6;
  const sb = Math.hypot(b.x1 - b.x0, b.y1 - b.y0) || 1e-6;
  return Math.hypot(ca.x - cb.x, ca.y - cb.y) / (0.5 * (sa + sb));
}

export function expandBox(b, sx = 1.4, up = 1.55, down = 1.3) {
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const w = (b.x1 - b.x0) * sx, h = b.y1 - b.y0;
  return { x0: cx - w / 2, y0: cy - h * 0.55 * up, x1: cx + w / 2, y1: cy + h * 0.45 * down };
}

function shiftBox(b, dx, dy) {
  return { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy };
}

export function shiftTrack(t, dx, dy, vw, vh) {
  t.box = shiftBox(t.box, dx, dy);
  if (t.kps) t.kps = t.kps.map((p) => [p[0] + dx * vw, p[1] + dy * vh]);
}

export class HeadLock {
  constructor() {
    const make = (w, h) => {
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
      c.width = w; c.height = h;
      return { c, ctx: c.getContext('2d', { willReadFrequently: true }) };
    };
    this.tpl = make(TW, TH);
    this.win = make(96, 96);
  }

  remember(source, t, vw, vh) {
    const roi = expandBox(t.box);
    const g = this._gray(source, roi, vw, vh, TW, TH);
    if (!g) return;
    t._tpl = g;
    t._hist = this._hist(source, roi, vw, vh);
    const c = boxCenter(t.box);
    if (t.cx == null) { t.cx = c.x; t.cy = c.y; t.vx = 0; t.vy = 0; }
  }

  // Move the track to follow the head in `source`. Returns confidence 0..1.
  follow(source, t, vw, vh, dt) {
    if (!t.box) return 0;
    const ms = Math.max(8, Math.min(120, dt || 16));
    const c = boxCenter(t.box);
    const px = clamp(c.x + (t.vx || 0) * ms, 0.02, 0.98);
    const py = clamp(c.y + (t.vy || 0) * ms, 0.02, 0.98);
    const bw = Math.max(0.04, t.box.x1 - t.box.x0);
    const bh = Math.max(0.04, t.box.y1 - t.box.y0);
    const reach = Math.min(0.28, Math.max(0.08, 0.55 * Math.max(bw, bh) + Math.hypot(t.vx || 0, t.vy || 0) * ms * 2));

    let nx = px, ny = py, ncc = 0, mass = 0;
    if (t._tpl) {
      const hit = this._searchNcc(source, t, vw, vh, px, py, reach);
      if (hit) { ncc = hit.ncc; nx = hit.x; ny = hit.y; }
    }
    if (t._hist) {
      const hs = this._meanshift(source, t, vw, vh, ncc >= 0.5 ? nx : px, ncc >= 0.5 ? ny : py);
      if (hs) {
        mass = hs.mass;
        if (ncc < 0.5 && mass >= 0.28) { nx = hs.x; ny = hs.y; }
        else if (ncc >= 0.5 && mass >= 0.22) {
          // both votes: blend if they agree, otherwise trust NCC
          const disagree = Math.hypot(hs.x - nx, hs.y - ny) / Math.max(bw, bh);
          if (disagree < 0.45) { nx = nx * 0.65 + hs.x * 0.35; ny = ny * 0.65 + hs.y * 0.35; }
        }
      }
    }
    // A name only stays "fresh" on a sharp template match. Colour alone can stick
    // to a similar background (e.g. a blue backdrop) and must not reset the timer.
    const conf = ncc >= 0.45 ? Math.min(1, (ncc - 0.2) / 0.8) : (mass >= 0.35 && ncc >= 0.25 ? Math.min(0.5, mass) : Math.max(0, ncc));
    if (ncc < 0.45) { nx = px; ny = py; }
    const dx = nx - c.x, dy = ny - c.y;
    shiftTrack(t, dx, dy, vw, vh);
    const a = 0.45;
    t.vx = (1 - a) * (t.vx || 0) + a * (dx / ms);
    t.vy = (1 - a) * (t.vy || 0) + a * (dy / ms);
    t.cx = nx; t.cy = ny;
    t._lastNcc = ncc; t._lastMass = mass;
    // only refresh the template when the match is sharp and we did not jump far
    if (ncc >= 0.7 && Math.hypot(dx, dy) < reach * 0.7) this.remember(source, t, vw, vh);
    return conf;
  }

  _gray(source, roi, vw, vh, tw, th) {
    const x = roi.x0 * vw, y = roi.y0 * vh, w = (roi.x1 - roi.x0) * vw, h = (roi.y1 - roi.y0) * vh;
    if (w < 4 || h < 4) return null;
    const { c, ctx } = this.tpl;
    if (c.width !== tw || c.height !== th) { c.width = tw; c.height = th; }
    try { ctx.drawImage(source, x, y, w, h, 0, 0, tw, th); } catch (_) { return null; }
    const d = ctx.getImageData(0, 0, tw, th).data;
    const g = new Float32Array(tw * th);
    let sum = 0;
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      const v = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
      g[i] = v; sum += v;
    }
    const mean = sum / g.length;
    let var_ = 0;
    for (let i = 0; i < g.length; i++) { const u = g[i] - mean; g[i] = u; var_ += u * u; }
    g._norm = Math.sqrt(var_) || 1;
    g._mean = mean;
    return g;
  }

  _searchNcc(source, t, vw, vh, px, py, reach) {
    const bw = t.box.x1 - t.box.x0, bh = t.box.y1 - t.box.y0;
    const roi = expandBox({ x0: px - bw / 2, y0: py - bh / 2, x1: px + bw / 2, y1: py + bh / 2 });
    const win = { x0: roi.x0 - reach, y0: roi.y0 - reach, x1: roi.x1 + reach, y1: roi.y1 + reach };
    const sx = win.x0 * vw, sy = win.y0 * vh, sw = (win.x1 - win.x0) * vw, sh = (win.y1 - win.y0) * vh;
    if (sw < 8 || sh < 8) return null;
    // work in a small window whose head is ~TW px
    const scale = TW / Math.max(8, (roi.x1 - roi.x0) * vw);
    const WW = Math.max(TW + 4, Math.round(sw * scale));
    const HH = Math.max(TH + 4, Math.round(sh * scale));
    const { c, ctx } = this.win;
    if (c.width !== WW || c.height !== HH) { c.width = WW; c.height = HH; }
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, WW, HH);
    try { ctx.drawImage(source, sx, sy, sw, sh, 0, 0, WW, HH); } catch (_) { return null; }
    const d = ctx.getImageData(0, 0, WW, HH).data;
    const gray = new Float32Array(WW * HH);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    const tpl = t._tpl, tn = tpl._norm, n = TW * TH;
    let best = -1, bx = 0, by = 0, second = -1, sumS = 0, nS = 0;
    const maxX = WW - TW, maxY = HH - TH;
    if (maxX < 0 || maxY < 0) return null;
    const step = maxX * maxY > 1600 ? 2 : 1;
    for (let y = 0; y <= maxY; y += step) for (let x = 0; x <= maxX; x += step) {
      const s = this._nccAt(gray, WW, x, y, tpl, tn, n);
      sumS += s; nS++;
      if (s > best) { second = best; best = s; bx = x; by = y; }
      else if (s > second) second = s;
    }
    if (step > 1) {
      const x0 = Math.max(0, bx - 2), y0 = Math.max(0, by - 2);
      const x1 = Math.min(maxX, bx + 2), y1 = Math.min(maxY, by + 2);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const s = this._nccAt(gray, WW, x, y, tpl, tn, n);
        if (s > best) { second = best; best = s; bx = x; by = y; }
      }
    }
    const meanS = nS ? sumS / nS : 0;
    // reject a flat field (uniform backdrop / empty frame): need a real peak
    if (best < 0.5 || best - meanS < 0.08 || (second >= 0 && best - second < 0.02 && best < 0.85)) {
      return { ncc: 0, x: px, y: py };
    }
    // displacement relative to the "no-move" slot (avoids origin mistakes)
    const scX = WW / sw, scY = HH / sh;
    const expBx = (roi.x0 * vw - sx) * scX;
    const expBy = (roi.y0 * vh - sy) * scY;
    const dx = (bx - expBx) / scX;
    const dy = (by - expBy) / scY;
    return { ncc: best, x: px + dx / vw, y: py + dy / vh };
  }

  _nccAt(gray, WW, x, y, tpl, tn, n) {
    let sum = 0, dot = 0;
    for (let r = 0, k = 0; r < TH; r++) {
      let o = (y + r) * WW + x;
      for (let q = 0; q < TW; q++, o++, k++) { const v = gray[o]; sum += v; dot += v * tpl[k]; }
    }
    const mean = sum / n;
    let var_ = 0;
    for (let r = 0; r < TH; r++) {
      let o = (y + r) * WW + x;
      for (let q = 0; q < TW; q++, o++) { const u = gray[o] - mean; var_ += u * u; }
    }
    const den = Math.sqrt(var_) * tn;
    if (den < 1e-2) return 0;   // no texture (blank / uniform)
    return dot / den;
  }

  _hist(source, roi, vw, vh) {
    const x = roi.x0 * vw, y = roi.y0 * vh, w = (roi.x1 - roi.x0) * vw, h = (roi.y1 - roi.y0) * vh;
    if (w < 4 || h < 4) return null;
    const tw = 48, th = 48;
    const { c, ctx } = this.tpl;
    const ow = c.width, oh = c.height;
    c.width = tw; c.height = th;
    try { ctx.drawImage(source, x, y, w, h, 0, 0, tw, th); } catch (_) { c.width = ow; c.height = oh; return null; }
    const d = ctx.getImageData(0, 0, tw, th).data;
    c.width = ow; c.height = oh;
    const hist = new Float32Array(H_BINS * S_BINS);
    let tot = 0;
    for (let i = 0; i < d.length; i += 4) {
      const [hh, ss, vv] = rgbToHsv(d[i], d[i + 1], d[i + 2]);
      if (vv < 0.12 || ss < 0.08) continue;   // skip near-black / grey (often background)
      const hb = Math.min(H_BINS - 1, (hh * H_BINS) | 0);
      const sb = Math.min(S_BINS - 1, (ss * S_BINS) | 0);
      hist[hb * S_BINS + sb]++; tot++;
    }
    if (tot < 20) return null;
    for (let i = 0; i < hist.length; i++) hist[i] /= tot;
    return hist;
  }

  _meanshift(source, t, vw, vh, px, py) {
    const hist = t._hist; if (!hist) return null;
    let cx = px, cy = py;
    const bw = t.box.x1 - t.box.x0, bh = t.box.y1 - t.box.y0;
    const tw = 48, th = 48;
    const { c, ctx } = this.win;
    let mass = 0;
    for (let iter = 0; iter < 5; iter++) {
      const roi = expandBox({ x0: cx - bw / 2, y0: cy - bh / 2, x1: cx + bw / 2, y1: cy + bh / 2 });
      const x = roi.x0 * vw, y = roi.y0 * vh, w = (roi.x1 - roi.x0) * vw, h = (roi.y1 - roi.y0) * vh;
      if (w < 4 || h < 4) return null;
      if (c.width !== tw || c.height !== th) { c.width = tw; c.height = th; }
      try { ctx.drawImage(source, x, y, w, h, 0, 0, tw, th); } catch (_) { return null; }
      const d = ctx.getImageData(0, 0, tw, th).data;
      let sw = 0, sx = 0, sy = 0;
      for (let j = 0, i = 0; j < th; j++) for (let i_ = 0; i_ < tw; i_++, i += 4) {
        const [hh, ss, vv] = rgbToHsv(d[i], d[i + 1], d[i + 2]);
        if (vv < 0.12 || ss < 0.08) continue;
        const hb = Math.min(H_BINS - 1, (hh * H_BINS) | 0);
        const sb = Math.min(S_BINS - 1, (ss * S_BINS) | 0);
        const wt = hist[hb * S_BINS + sb];
        if (wt <= 0) continue;
        sw += wt; sx += wt * i_; sy += wt * j;
      }
      mass = sw;
      if (sw < 1e-6) return { x: cx, y: cy, mass: 0 };
      const nx = x + (sx / sw + 0.5) / tw * w;
      const ny = y + (sy / sw + 0.5) / th * h;
      const ncx = nx / vw, ncy = ny / vh;
      if (Math.hypot(ncx - cx, ncy - cy) < 0.004) { cx = ncx; cy = ncy; break; }
      cx = ncx; cy = ncy;
    }
    // mass is sum of histogram probabilities (not normalised to 1). A well-matched
    // window is typically a few units; map to 0..1 roughly.
    const massN = Math.max(0, Math.min(1, mass / 8));
    return { x: cx, y: cy, mass: massN };
  }
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6; if (h < 0) h += 1;
  }
  return [h, max ? d / max : 0, max];
}
