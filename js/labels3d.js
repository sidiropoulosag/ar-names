// three.js overlay: extruded, bevelled 3D names that follow each face.
import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

const tmpE = new THREE.Euler();

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
      let rec = this.meshes.get(t.id);
      if (!rec || rec.text !== text) {
        if (rec) this.scene.remove(rec.mesh);
        const mesh = new THREE.Mesh(this.geometry(text), unk ? [this.matUnkFront, this.matUnkSide] : [this.matFront, this.matSide]);
        this.scene.add(mesh);
        rec = { mesh, text, born: now, sm: rec ? rec.sm : null };
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
      const gw = rec.mesh.geometry.boundingBox ? (rec.mesh.geometry.boundingBox.max.x - rec.mesh.geometry.boundingBox.min.x) : 0.6 * text.length;
      // fit the whole word on screen (92% of the width) for close-up faces
      const size = Math.max(14, Math.min(150, fw * (unk ? 0.35 : 0.3), (W * 0.92) / Math.max(gw, 0.5)));
      // eyes sit ~40% down the box; go up to the top of the head + a small gap
      const lift = fh * 0.5 + size * 0.25;
      let px = ex + ux * lift, py = ey + uy * lift;
      // keep the whole name on screen (below the top bar) even for very close faces
      py = Math.max(py, size * 1.3 + 64);
      const half = size * gw / 2 + 4;
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
      rec.msg = t.message || ''; rec.sx = k.x; rec.sy = k.y; rec.ss = k.s * ease; // for the HTML message bubble
      rec.mesh.position.set(k.x, H - k.y, 0);
      rec.mesh.quaternion.copy(k.q);
      rec.mesh.scale.setScalar(k.s * ease);
    }
    for (const [id, rec] of this.meshes) if (!alive.has(id)) { this.scene.remove(rec.mesh); this.meshes.delete(id); }
    this.renderer.render(this.scene, this.camera);
  }
  clear() { for (const [, r] of this.meshes) this.scene.remove(r.mesh); this.meshes.clear(); this.renderer.render(this.scene, this.camera); }
}
