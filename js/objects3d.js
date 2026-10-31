// 3D objects a person can choose to show above their head (instead of a message).
// REGISTRY: to add an object later, add ONE entry to OBJECTS below, either
//   { id, name, emoji, url: 'models3d/<file>.glb', thumb: 'models3d/thumbs/<file>.png' }   (a glTF model), or
//   { id, name, emoji, build: (THREE) => THREE.Object3D }                                   (three.js primitives)
// id: a-z, 0-9, - or _, max 32 (the server stores only the id). Models are auto-scaled to 1 unit tall,
// centred, and loop their 'Flying_Idle' / 'idle' animation (or their first moving one).
// Models are loaded only when someone actually needs one (a recognised person chose it, or it is picked in
// Settings); the service worker caches each file on first use — nothing is precached.
import * as THREE from 'three';
import { t } from './i18n.js';

const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.05, ...o });
const mesh = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); return m; };
const sphere = (r, seg = 24) => new THREE.SphereGeometry(r, seg, Math.round(seg * 0.75));

function bird() {
  const g = new THREE.Group();
  const yel = std(0xffd23f), ora = std(0xff8c1a), blk = std(0x111111, { roughness: 0.2 }), wing = std(0xf2b705);
  const body = mesh(sphere(0.32), yel, 0, -0.12, 0); body.scale.set(1, 0.9, 0.95); g.add(body);
  g.add(mesh(sphere(0.22), yel, 0, 0.25, 0.05));
  const beak = mesh(new THREE.ConeGeometry(0.07, 0.18, 16), ora, 0, 0.23, 0.3); beak.rotation.x = Math.PI / 2; g.add(beak);
  for (const s of [-1, 1]) {
    g.add(mesh(sphere(0.035, 12), blk, s * 0.09, 0.31, 0.2));
    const w = mesh(sphere(0.18), wing, s * 0.3, -0.1, 0); w.scale.set(0.35, 0.75, 0.9); w.rotation.z = s * 0.5; w.userData.wing = s; g.add(w);
    const leg = mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.14, 8), ora, s * 0.1, -0.44, 0.02); g.add(leg);
  }
  const tail = mesh(new THREE.ConeGeometry(0.12, 0.25, 12), wing, 0, -0.1, -0.33); tail.rotation.x = -Math.PI / 2.6; g.add(tail);
  g.userData.anim = (o, t) => { for (const c of o.children) if (c.userData.wing) c.rotation.z = c.userData.wing * (0.5 + 0.35 * Math.sin(t * 9)); };
  return g;
}

function teddy() {
  const g = new THREE.Group();
  const fur = std(0x9c6b3e, { roughness: 0.8 }), light = std(0xd9b38c, { roughness: 0.8 }), blk = std(0x1a1a1a, { roughness: 0.2 });
  const body = mesh(sphere(0.27), fur, 0, -0.22, 0); body.scale.set(1, 1.05, 0.9); g.add(body);
  const belly = mesh(sphere(0.17), light, 0, -0.22, 0.14); belly.scale.set(1, 1.1, 0.6); g.add(belly);
  g.add(mesh(sphere(0.22), fur, 0, 0.2, 0));
  const muzzle = mesh(sphere(0.09), light, 0, 0.15, 0.18); muzzle.scale.set(1.2, 0.85, 0.8); g.add(muzzle);
  g.add(mesh(sphere(0.035, 12), blk, 0, 0.18, 0.26));
  for (const s of [-1, 1]) {
    g.add(mesh(sphere(0.08), fur, s * 0.17, 0.39, -0.02));
    g.add(mesh(sphere(0.045), light, s * 0.17, 0.39, 0.03));
    g.add(mesh(sphere(0.028, 12), blk, s * 0.08, 0.26, 0.18));
    g.add(mesh(sphere(0.09), fur, s * 0.28, -0.15, 0.05));     // arms
    g.add(mesh(sphere(0.1), fur, s * 0.15, -0.46, 0.08));      // feet
  }
  return g;
}

function smiley() {
  const g = new THREE.Group();
  const yel = std(0xffcc00, { emissive: 0x332200 }), blk = std(0x222222, { roughness: 0.3 });
  g.add(mesh(sphere(0.45, 32), yel));
  for (const s of [-1, 1]) { const e = mesh(sphere(0.06, 16), blk, s * 0.15, 0.12, 0.4); e.scale.set(0.8, 1.4, 0.6); g.add(e); }
  const mouth = mesh(new THREE.TorusGeometry(0.22, 0.035, 10, 32, Math.PI), blk, 0, -0.02, 0.37);
  mouth.rotation.z = Math.PI; mouth.rotation.x = -0.25; g.add(mouth);
  return g;
}

// m01–m17: flying creatures; m18–m41: Kenney «Cube Pets» animals (CC0, see licenses/), texture in models3d/Textures/.
// v27: names in the app's language (i18n.js obj.m01 … obj.smiley); `name` is a getter, so a language change applies at once
const named = (o) => Object.defineProperty(o, 'name', { get: () => t('obj.' + o.id), enumerable: true });
const MODELS = Array.from({ length: 41 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return named({ id: 'm' + n, emoji: '👾', url: `models3d/m${n}.glb`, thumb: `models3d/thumbs/m${n}.png` });
});
export const OBJECTS = [
  ...MODELS,
  // cheap placeholders made of primitives (no download)
  named({ id: 'bird', emoji: '🐦', build: bird }),
  named({ id: 'teddy', emoji: '🧸', build: teddy }),
  named({ id: 'smiley', emoji: '😊', build: smiley }),
];
export const DEFAULT_OBJECT = 'smiley';
// Unknown ids (e.g. an object added in a newer app version) fall back to the default object.
export const objectInfo = (id) => OBJECTS.find((o) => o.id === id) || OBJECTS.find((o) => o.id === DEFAULT_OBJECT);

const base = new URL('../', import.meta.url);   // site root (works under /ar-names/)
export const assetUrl = (rel) => new URL(rel, base).href;

// ---- glTF models: loaded once per id (lazy), then cloned per use ----
let loaderP = null;
const getLoader = () => loaderP || (loaderP = Promise.all([
  import('three/addons/loaders/GLTFLoader.js'), import('three/addons/utils/SkeletonUtils.js'),
]).then(([g, su]) => ({ loader: new g.GLTFLoader(), clone: su.clone })));
const models = new Map(); // id -> Promise<{ scene, clip, clone }>
export function loadModel(info) {
  let p = models.get(info.id);
  if (!p) {
    p = getLoader().then(async ({ loader, clone }) => {
      const g = await loader.loadAsync(assetUrl(info.url));
      const scene = g.scene;
      scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(scene, true), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
      const k = 1 / (Math.max(size.y, size.x * 0.8) || 1);            // 1 unit tall (wide ones: limited by width)
      const norm = new THREE.Group(); norm.add(scene);
      scene.position.sub(c); norm.scale.setScalar(k);
      scene.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });   // skinned + animated: never cull
      const A = g.animations, low = (a) => (a.name || '').toLowerCase();
      const clip = A.find((a) => a.name === 'Flying_Idle') || A.find((a) => low(a) === 'idle') || A.find((a) => /idle/.test(low(a)))
        || A.find((a) => low(a) !== 'static' && a.duration > 0) || A[0] || null;    // idle loop if the model has one
      return { scene: norm, clip, clone };
    });
    p.catch(() => models.delete(info.id));   // retry next time (e.g. was offline)
    models.set(info.id, p);
  }
  return p;
}

const built = new Map();
// A copy of the object to put in a scene. glTF models appear as soon as they are loaded
// (an empty group until then). Geometry/materials are shared between copies.
export function makeObject(id) {
  const info = objectInfo(id);
  if (info.url) {
    const holder = new THREE.Group();
    holder.userData = { objectId: info.id, loading: true };
    loadModel(info).then(({ scene, clip, clone }) => {
      const o = clone(scene);
      holder.add(o);
      if (clip) { const m = new THREE.AnimationMixer(o); m.clipAction(clip).play(); holder.userData.mixer = m; }
      holder.userData.loading = false;
    }).catch((e) => { console.warn('3D model', info.id, e); holder.userData.loading = false; holder.userData.failed = true; });
    return holder;
  }
  let proto = built.get(info.id);
  if (!proto) { proto = info.build(THREE); built.set(info.id, proto); }
  const o = proto.clone(true);
  o.userData = { ...proto.userData, objectId: info.id };
  return o;
}
// Idle motion, t in seconds (models: their own animation; primitives: gentle sway).
export function animateObject(o, t) {
  const u = o.userData;
  if (u.mixer) { u.mixer.update(u.lastT ? Math.min(0.1, t - u.lastT) : 0); u.lastT = t; o.rotation.y = Math.sin(t * 0.8) * 0.3; return; }
  o.rotation.y = Math.sin(t * 1.3) * 0.45;
  if (u.anim) u.anim(o, t);
}

// Small spinning preview on a <canvas> (used in Settings → «Τι δείχνω»).
let pv = null;
export function previewObject(canvas, id) {
  if (!pv || pv.canvas !== canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const dl = new THREE.DirectionalLight(0xffffff, 2.2); dl.position.set(0.4, 1, 1.2); scene.add(dl);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 20); camera.position.set(0, 0.1, 2.6);
    pv = { canvas, renderer, scene, camera, obj: null, raf: 0 };
  }
  if (pv.obj) pv.scene.remove(pv.obj);
  pv.obj = makeObject(id); pv.scene.add(pv.obj);
  const w = canvas.clientWidth || 120, h = canvas.clientHeight || 120;
  pv.renderer.setSize(w, h, false); pv.camera.aspect = w / h; pv.camera.updateProjectionMatrix();
  cancelAnimationFrame(pv.raf);
  const tick = (ms) => {
    if (!canvas.isConnected || canvas.offsetParent === null) { pv.raf = 0; return; }   // stop when hidden
    animateObject(pv.obj, ms / 1000); pv.obj.rotation.y = ms / 1500;
    pv.renderer.render(pv.scene, pv.camera);
    pv.raf = requestAnimationFrame(tick);
  };
  pv.raf = requestAnimationFrame(tick);
}
