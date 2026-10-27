// three.js overlay: extruded, bevelled 3D names that follow each face.
import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { makeObject, animateObject } from './objects3d.js';

const tmpE = new THREE.Euler();
const clampS = (v) => (Number.isFinite(+v) && v !== null ? Math.min(2, Math.max(0.5, +v)) : 1);

export class Labels3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, -5000, 5000);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const dl = new THREE.DirectionalLight(0xffffff, 2.2); dl.position.set(0.4, 1, 1.2); this.scene.add(dl);
    const dl2 = new THREE.DirectionalLight(0x88bbff, 0.8); dl2.position.set(-1, -0.3, 0.6); this.scene.add(dl2);
    this.matFront = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.05, emissive: 0x222222 });
    this.matSide = new THREE.MeshStandardMaterial({ color: 0x1565c0, roughness: 0.4, metalness: 0.2 });
    this.matUnkFront = new THREE.MeshStandardMaterial({ color: 0xffc107, roughness: 0.4, emissive: 0x221100 });
    this.matUnkSide = new THREE.MeshStandardMaterial({ color: 0x8d5a00, roughness: 0.5 });
    this.geoCache = new Map();
    this.meshes = new Map(); // track id -> {group, mesh, text}
    this.mirror = false; this.W = 1; this.H = 1;
  }
  async init(fontUrl) {
    this.font = await new FontLoader().loadAsync(fontUrl);
  }
  resize(W, H) {
    this.W = W; this.H = H;
    this.renderer.setSize(W, H, false);
    Object.assign(this.camera, { left: 0, right: W, top: H, bottom: 0 });
    this.camera.updateProjectionMatrix();
  }
  geometry(text) {
    let g = this.geoCache.get(text);
    if (g) return g;
    g = new TextGeometry(text, { font: this.font, size: 1, depth: 0.28, curveSegments: 5,
      bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.035, bevelSegments: 3 });
    g.computeBoundingBox();
    const bb = g.boundingBox;
    g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -0.14);
    g.computeVertexNormals();
    this.geoCache.set(text, g);
    if (this.geoCache.size > 200) { const k = this.geoCache.keys().next().value; this.geoCache.get(k).dispose(); this.geoCache.delete(k); }
    return g;
  }
  // tracks: from Tracker; map: {vw, vh} video size; showUnknown
  render(tracks, vw, vh, showUnknown, now = performance.now()) {
    const W = this.W, H = this.H;
    const s = Math.max(W / vw, H / vh), ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
    const toScreen = (p) => {
      let x = p.x * vw * s + ox; const y = p.y * vh * s + oy;
      if (this.mirror) x = W - x;
      return [x, y];
    };
    const alive = new Set();
    for (const t of tracks) {
      let text = null, unk = false;
      if (t.label) text = t.label;
      else if (showUnknown && t.embeds >= 3) { text = '?'; unk = true; }
      if (!text || t.missed > 3) continue;
      alive.add(t.id);
      // what this person chose (0.4.0): name on/off + per-person sizes (0.5-2); defaults = name, x1
      const showName = unk || t.showName !== false;
      const sz = (!unk && t.sizes) || null;
      const sN = clampS(sz && sz.name), sT = clampS(sz && sz.text), sO = clampS(sz && sz.object);
      const key = showName ? text : '\u0000' + text;
      let rec = this.meshes.get(t.id);
      if (!rec || rec.key !== key) {
        if (rec) { if (rec.mesh) this.scene.remove(rec.mesh); if (rec.obj) this.scene.remove(rec.obj); }
        const mesh = showName ? new THREE.Mesh(this.geometry(text), unk ? [this.matUnkFront, this.matUnkSide] : [this.matFront, this.matSide]) : null;
        if (mesh) this.scene.add(mesh);
        rec = { mesh, key, text, born: now, sm: rec ? rec.sm : null };
        this.meshes.set(t.id, rec);
      }
      // anchor above the head along the face's up direction (mouth -> eyes)
      const k5 = t.kps;
      const exm = (k5[0][0] + k5[1][0]) / 2, eym = (k5[0][1] + k5[1][1]) / 2;
      const mxm = (k5[3][0] + k5[4][0]) / 2, mym = (k5[3][1] + k5[4][1]) / 2;
      const [ex, ey] = toScreen({ x: exm / vw, y: eym / vh });
      const [mx, my] = toScreen({ x: mxm / vw, y: mym / vh });
      let ux = ex - mx, uy = ey - my; const em = Math.hypot(ux, uy) || 1; ux /= em; uy /= em;
      const fw = (t.box.x1 - t.box.x0) * vw * s;
      const fh = (t.box.y1 - t.box.y0) * vh * s;
      const bb = rec.mesh && rec.mesh.geometry.boundingBox;
      const gw = rec.mesh ? (bb ? bb.max.x - bb.min.x : 0.6 * text.length) : 0;
      // base size from the face width (smoothed below); the name's own size also fits the screen width
      const size = Math.max(14, Math.min(150, fw * (unk ? 0.35 : 0.3)));
      // eyes sit ~40% down the box; go up to the top of the head + a small gap
      const lift = fh * 0.5 + size * 0.25;
      let px = ex + ux * lift, py = ey + uy * lift;
      const objId = (!unk && t.objectId) || '';
      // stack, from the head up: name -> 3D object -> (HTML) comment bubble
      const nameS = (b) => (gw ? Math.max(10, Math.min(b * sN, (W * 0.92) / Math.max(gw, 0.5))) : 0);
      const stackH = (b) => (gw ? nameS(b) * 1.05 : b * 0.15) + (objId ? b * 2.2 * sO * 1.1 : 0);
      // keep the whole stack on screen (below the top bar) even for very close faces
      // (+ room for the comment bubble above it, so it does not have to drop over the face)
      const msg = (!unk && t.message) || '';
      const bubH = msg ? (16 * sT * 1.3) * Math.min(4, msg.split('\n').length) + 18 : 0;
      py = Math.max(py, stackH(size) + 64 + size * 0.25 + Math.min(bubH, H * 0.25));
      const half = Math.max(nameS(size) * gw / 2, objId ? size * 1.1 * sO : 0) + 4;
      px = Math.min(Math.max(px, Math.min(W / 2, half)), Math.max(W / 2, W - half));
      // head orientation from the 5-point pose estimate (damped)
      const m = this.mirror ? -1 : 1, D = Math.PI / 180;
      tmpE.set(t.pose.pitch * D * 0.7, m * t.pose.yaw * D * 0.8, -m * t.pose.roll * D, 'YXZ');
      const q = new THREE.Quaternion().setFromEuler(tmpE);
      const sm = rec.sm;
      if (!sm) rec.sm = { x: px, y: py, s: size, q: q.clone() };
      else {
        const d = Math.hypot(px - sm.x, py - sm.y);
        const a = Math.min(0.9, 0.35 + d / (size * 2)); // adaptive low-pass (fast moves -> less smoothing)
        sm.x += (px - sm.x) * a; sm.y += (py - sm.y) * a; sm.s += (size - sm.s) * 0.3;
        sm.q.slerp(q, 0.35);
      }
      const k = rec.sm, pop = Math.min(1, (now - rec.born) / 180);
      const ease = 1 - Math.pow(1 - pop, 3);
      const ns = nameS(k.s), nameH = gw ? ns * 1.05 : k.s * 0.15;
      if (rec.mesh) {
        rec.mesh.position.set(k.x, H - k.y, 0);
        rec.mesh.quaternion.copy(k.q);
        rec.mesh.scale.setScalar(ns * ease);
      }
      if (rec.objWant !== objId) {
        if (rec.obj) { this.scene.remove(rec.obj); rec.obj = null; }
        rec.objWant = objId;
        if (objId) { rec.obj = makeObject(objId); this.scene.add(rec.obj); rec.objBorn = now; }
      }
      let top = k.y - nameH;                              // screen y of the top of the stack
      if (rec.obj) {
        const full = k.s * 2.2 * sO, os = full * Math.min(1, (now - rec.objBorn) / 250);
        rec.obj.position.set(k.x, H - k.y + nameH + os * 0.55, 0);
        rec.obj.scale.setScalar(os);
        animateObject(rec.obj, now / 1000);
        top -= full * 1.1;
      }
      // for the HTML comment bubble: above the stack; `low` = fallback spot just under the name
      rec.msg = (!unk && t.message) || ''; rec.sx = k.x; rec.sy = k.y; rec.ss = ns * ease;
      rec.top = top - k.s * 0.08; rec.low = k.y + 6; rec.textScale = sT;
      rec.hasObj = !!rec.obj;
    }
    for (const [id, rec] of this.meshes) if (!alive.has(id)) { if (rec.mesh) this.scene.remove(rec.mesh); if (rec.obj) this.scene.remove(rec.obj); this.meshes.delete(id); }
    this.renderer.render(this.scene, this.camera);
  }
  clear() { for (const [, r] of this.meshes) { if (r.mesh) this.scene.remove(r.mesh); if (r.obj) this.scene.remove(r.obj); } this.meshes.clear(); this.renderer.render(this.scene, this.camera); }
}
