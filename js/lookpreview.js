// v31: live preview on Settings → «Εμφάνιση και ήχος». The SAME three.js label code as the camera screen
// (Labels3D: same text styles / materials / sizes / 3D objects / comment bubble) drawn over a sample person,
// so every choice shows at once what the others will see. Only runs while that page is open; on leave
// everything it created (geometries, materials, textures, the WebGL context) is disposed.
import { Labels3D } from './labels3d.js';

const K = 2;          // the scene is laid out like a real phone screen and shown at 1/K size
const FRAME_MS = 32;  // ~30 fps is plenty for a preview (keeps the camera loop behind it light)
export const lookStats = { created: 0, disposed: 0, alive: 0, frames: 0, starts: 0, ownedLive: 0 };

// v43: the preview face is the Noera avatar in a cafe (tutorial/preview-avatar.webp).
// HEAD is the face box in the SOURCE image, 0–1. If that JPEG is regenerated, re-measure
// (hair line, chin, face center) or run a screenshot and tweak these numbers.
const PREVIEW_SRC = 'tutorial/preview-avatar.webp';
const HEAD = { cx: 0.48, top: 0.29, bottom: 0.70, fw: 0.42 };

// Give a preview copy of a 3D object its own geometry / materials / textures, so they can be disposed
// on leave without touching the copies the camera screen uses (makeObject() shares them between copies).
function own(root, bag) {
  const seen = new Map();
  const dup = (x) => { if (!seen.has(x)) { const c = x.clone(); seen.set(x, c); bag.add(c); } return seen.get(x); };
  root.traverse((o) => {
    if (!o.isMesh && !o.isPoints && !o.isLine) return;
    o.geometry = dup(o.geometry);
    if (o.isSkinnedMesh && o.skeleton) bag.add(o.skeleton);   // its bone texture is per copy too
    const one = (m) => {
      const c = dup(m);
      for (const k of Object.keys(c)) if (c[k] && c[k].isTexture) c[k] = dup(m[k]);
      return c;
    };
    o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
  });
}
function freeObject(o) {
  const u = o.userData || {};
  if (u.mixer) { u.mixer.stopAllAction(); u.mixer.uncacheRoot(u.mixer.getRoot()); u.mixer = null; }
  if (u.owned) { for (const x of u.owned) x.dispose(); u.owned.clear(); lookStats.ownedLive--; }
}

export class LookPreview {
  // host: the #lookPrev box; getState(): what to show now; getFont(): the camera screen's loaded font (or null)
  constructor(host, { getState, getFont, fontUrl }) {
    Object.assign(this, { host, getState, getFont, fontUrl });
    this.bg = host.querySelector('.lp-bg'); this.layer = host.querySelector('.lp-layer');
    this.on = false; this.lab = null; this.canvas = null; this.raf = 0; this.last = 0; this.bub = null;
    this.objs = new Set(); this.fontP = null; this.popAt = 0; this.sig = '';
    this.ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.on && this.layout()) : null;
    this.view = null;
    this.photo = new Image();
    this.photo.onload = () => { this.sig = ''; if (this.on) this.draw(performance.now()); };
    this.photo.onerror = () => { this.sig = ''; };
    this.photo.src = PREVIEW_SRC;
  }
  async font() {
    const f = this.getFont && this.getFont();
    if (f) return f;
    if (!this.fontP) {   // the camera screen has not loaded it yet (settings opened very early)
      const { FontLoader } = await import('three/addons/loaders/FontLoader.js');
      this.fontP = new FontLoader().loadAsync(this.fontUrl);
      this.fontP.catch(() => { this.fontP = null; });
    }
    return this.fontP;
  }
  async start() {
    if (this.on) { this.draw(performance.now()); return; }
    this.on = true; lookStats.starts++;
    const canvas = document.createElement('canvas'); canvas.className = 'lp-3d';   // a fresh canvas = a fresh context
    this.host.insertBefore(canvas, this.layer);
    const lab = new Labels3D(canvas);
    lookStats.created++; lookStats.alive++;
    lab.topPad = 40;  // v43: leave room for the name above the avatar's hair
    lab.beforeDraw = () => this.track();
    Object.assign(this, { canvas, lab });
    if (this.ro) this.ro.observe(this.host);
    this.layout();
    try { lab.font = await this.font(); } catch (e) { console.warn('preview font', e); }
    if (!this.on || this.lab !== lab) return;
    this.draw(performance.now());
    const tick = (ms) => {
      if (!this.on || this.lab !== lab) return;
      this.raf = requestAnimationFrame(tick);
      if (document.hidden || ms - this.last < FRAME_MS) return;
      this.draw(ms);
    };
    this.raf = requestAnimationFrame(tick);
  }
  stop() {
    if (!this.on) return;
    this.on = false; cancelAnimationFrame(this.raf); this.raf = 0;
    if (this.ro) this.ro.disconnect();
    const lab = this.lab;
    if (lab) {
      for (const [, r] of lab.meshes) if (r.obj) this.objs.add(r.obj);
      for (const o of this.objs) { if (o.parent) o.parent.remove(o); freeObject(o); }
      this.objs.clear();
      lab.dispose();
      lookStats.disposed++; lookStats.alive--;
    }
    if (this.canvas) this.canvas.remove();
    if (this.bub) { this.bub.remove(); this.bub = null; }
    this.lab = null; this.canvas = null; this.sig = '';
  }
  pop() { this.popAt = performance.now(); if (this.on) this.draw(this.popAt); }   // replay the «just recognised» pop
  // keep 3D objects owned by the preview; free the ones that were replaced (e.g. another object picked)
  track() {
    const now = new Set();
    for (const [, r] of this.lab.meshes) if (r.obj) now.add(r.obj);
    for (const o of now) {
      if (!this.objs.has(o)) this.objs.add(o);
      const u = o.userData;
      if (!u.owned && !u.loading) { u.owned = new Set(); own(o, u.owned); lookStats.ownedLive++; }
    }
    for (const o of this.objs) if (!now.has(o)) { freeObject(o); this.objs.delete(o); }
  }
  layout() {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    if (this.lab) {
      this.lab.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) / K);
      this.lab.resize(w * K, h * K);
    }
    this.layer.style.width = w * K + 'px'; this.layer.style.height = h * K + 'px';
    this.layer.style.transform = `scale(${1 / K})`;
    this.size = { w, h }; this.sig = '';
  }
  // Map the avatar's head from the source photo into the preview box, leaving room above the hair for labels.
  prepareView() {
    const { w, h } = this.size || { w: 0, h: 0 };
    const img = this.photo;
    if (!w || !h || !img || !img.naturalWidth) { this.view = null; return; }
    const sw0 = img.naturalWidth, sh0 = img.naturalHeight;
    const hairY = HEAD.top * sh0, chinY = HEAD.bottom * sh0;
    const aspect = w / h;
    let srcH = sw0 / aspect, srcW = sw0;
    if (srcH > sh0) { srcH = sh0; srcW = srcH * aspect; }
    let srcX = Math.max(0, HEAD.cx * sw0 - srcW / 2);
    if (srcX + srcW > sw0) srcX = Math.max(0, sw0 - srcW);
    // Prefer ~32% of the window above the hair so the name / object / message fit; keep the chin if possible.
    let srcY = hairY - 0.40 * srcH;
    if (srcY + srcH < chinY + 0.04 * sh0) srcY = Math.min(hairY - 0.28 * srcH, chinY + 0.04 * sh0 - srcH);
    srcY = Math.max(0, Math.min(srcY, sh0 - srcH));
    this.view = { srcX, srcY, srcW, srcH, sw0, sh0, w, h };
  }
  // me = the avatar's real head (labels sit above it). If «?» is on, a small unknown face on the right.
  people(st) {
    const VW = this.size.w * K, VH = this.size.h * K;
    const out = [];
    const add = (id, cx, fw, y0, fh) => {
      if (y0 == null) { fh = fw * 1.3; y0 = VH - fh * 1.12; }
      const y1 = y0 + fh;
      const kps = [[cx - fw * 0.18, y0 + fh * 0.42], [cx + fw * 0.18, y0 + fh * 0.42], [cx, y0 + fh * 0.56], [cx - fw * 0.14, y0 + fh * 0.74], [cx + fw * 0.14, y0 + fh * 0.74]];
      const p = { id, cx, fw, fh, y0, kps, box: { x0: (cx - fw / 2) / VW, x1: (cx + fw / 2) / VW, y0: y0 / VH, y1: y1 / VH } };
      out.push(p); return p;
    };
    const v = this.view;
    if (v && v.srcW) {
      const cx = ((HEAD.cx * v.sw0 - v.srcX) / v.srcW) * VW;
      const y0 = ((HEAD.top * v.sh0 - v.srcY) / v.srcH) * VH;
      const y1 = ((HEAD.bottom * v.sh0 - v.srcY) / v.srcH) * VH;
      const fw = (HEAD.fw * v.sw0 / v.srcW) * VW;
      add(1, cx, fw, y0, y1 - y0);
    } else {
      add(1, VW * 0.5, Math.min(VH * 0.22, VW * 0.22));
    }
    if (st.unknown) add(2, VW * 0.88, Math.min(VH * 0.14, VW * 0.12));
    return out;
  }
  background(ppl, st) {   // v43: cafe + avatar photo; fallback gradient if the image is still loading
    const ready = !!(this.photo && this.photo.naturalWidth);
    const sig = `${this.size.w}x${this.size.h}:${st.unknown ? 1 : 0}:${ready ? 1 : 0}:${this.view ? this.view.srcY.toFixed(1) : 0}`;
    if (sig === this.sig) return;
    this.sig = sig;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), { w, h } = this.size, c = this.bg;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = this.view;
    if (ready && v) {
      g.drawImage(this.photo, v.srcX, v.srcY, v.srcW, v.srcH, 0, 0, w, h);
    } else {
      const bgr = g.createLinearGradient(0, 0, 0, h); bgr.addColorStop(0, '#33475b'); bgr.addColorStop(1, '#1b2633');
      g.fillStyle = bgr; g.fillRect(0, 0, w, h);
    }
    for (const p of ppl) {
      if (p.id !== 2) continue;   // only the optional unknown face is drawn as a silhouette
      const cx = p.cx / K, fw = p.fw / K, fh = p.fh / K, y0 = p.y0 / K;
      g.fillStyle = '#5d6d7e';
      g.beginPath(); g.ellipse(cx, h + fh * 0.2, fw * 1.25, fh * 0.75, 0, Math.PI, 0); g.fill();
      g.fillRect(cx - fw * 0.2, y0 + fh * 0.8, fw * 0.4, fh * 0.4);
      g.fillStyle = '#7b8a99';
      g.beginPath(); g.ellipse(cx, y0 + fh / 2, fw / 2, fh / 2, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#4e5b68';
      g.beginPath(); g.ellipse(cx, y0 + fh * 0.18, fw * 0.5, fh * 0.2, 0, Math.PI, 0); g.fill();
    }
  }
  draw(ms) {
    const lab = this.lab;
    if (!lab || !lab.font || !this.on) return;
    this.last = ms;
    const st = this.getState();
    this.prepareView();
    const ppl = this.people(st);
    this.background(ppl, st);
    const t = ms / 1000, VW = this.size.w * K, VH = this.size.h * K;
    const tracks = ppl.map((p) => (p.id === 1 ? {
      id: 1, label: st.name, kps: p.kps, box: p.box, missed: 0, embeds: 5,
      pose: { yaw: Math.sin(t * 0.7) * 10, pitch: Math.sin(t * 0.5) * 4, roll: Math.sin(t * 0.9) * 3 },
      showName: st.showName, sizes: st.sizes, style: st.style, objectId: st.objectId, filterId: st.filterId || '', message: st.message,
    } : { id: 2, label: null, kps: p.kps, box: p.box, missed: 0, embeds: 5, pose: { yaw: 0, pitch: 0, roll: Math.sin(t * 0.6) * 4 } }));
    if (this.popAt) { const r = lab.meshes.get(1); if (r) { r.born = this.popAt; if (r.obj) r.objBorn = this.popAt; } this.popAt = 0; }
    lab.render(tracks, VW, VH, !!st.unknown, ms);
    lookStats.frames++;
    this.bubble(lab.meshes.get(1));
  }
  bubble(rec) {   // the comment bubble: the same .bubble element and placement as on the camera screen
    if (!rec || !rec.msg || rec.sx === undefined) { if (this.bub) { this.bub.remove(); this.bub = null; } return; }
    if (!this.bub) { this.bub = document.createElement('div'); this.bub.className = 'bubble'; this.layer.appendChild(this.bub); }
    const el = this.bub;
    if (el.textContent !== rec.msg) el.textContent = rec.msg;
    const fs = Math.round(16 * (rec.textScale || 1)) + 'px';
    if (el.style.fontSize !== fs) el.style.fontSize = fs;
    const top = rec.top ?? rec.sy - rec.ss * 1.2;
    const pad = this.lab.topPad, h = el.offsetHeight || 24;
    const y = Math.max(top, pad + h);
    el.style.transform = `translate(${rec.sx}px, ${y}px) translate(-50%, -100%)`;
  }
  // tests / screenshots: draw now and read the pixels in the same task (no preserveDrawingBuffer)
  snapshot() {
    if (!this.on || !this.lab || !this.lab.font) return null;
    this.draw(performance.now());
    const c = this.canvas, w = 96, h = Math.max(1, Math.round(96 * c.height / c.width));
    const g = document.createElement('canvas'); g.width = w; g.height = h;
    const x = g.getContext('2d', { willReadFrequently: true }); x.drawImage(c, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data; let hash = 0, lit = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 20) { lit++; hash = (hash * 31 + (d[i] >> 3) * 7 + (d[i + 1] >> 3) * 13 + (d[i + 2] >> 3) + i) >>> 0; } }
    const r = this.lab.meshes.get(1), mem = this.lab.renderer.info.memory;
    return { hash, lit, w, h, style: r && r.style, obj: (r && r.objWant) || '', nameScale: r && r.mesh ? +r.mesh.scale.x.toFixed(2) : 0, objScale: r && r.obj ? +r.obj.scale.x.toFixed(2) : 0, name: r ? r.text : '',
      bubble: this.bub ? this.bub.textContent : '', bubbleFs: this.bub ? this.bub.style.fontSize : '', unknown: this.lab.meshes.has(2),
      geometries: mem.geometries, textures: mem.textures, owned: this.objs.size };
  }
}
