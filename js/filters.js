// v33: funny / seasonal name filters (crown, hat, confetti, halo, Christmas, Halloween).
// Shown above the 3D name. Seasonal ones auto-suggest in-season; user can always pick manually.
import { t } from './i18n.js';

export const FILTERS = [
  { id: '',         emoji: '🚫', key: 'filt.none' },
  { id: 'crown',    emoji: '👑', key: 'filt.crown' },
  { id: 'hat',      emoji: '🎩', key: 'filt.hat' },
  { id: 'confetti', emoji: '🎊', key: 'filt.confetti' },
  { id: 'halo',     emoji: '😇', key: 'filt.halo' },
  { id: 'xmas',     emoji: '🎄', key: 'filt.xmas', season: 'xmas' },
  { id: 'halloween',emoji: '🎃', key: 'filt.halloween', season: 'halloween' },
];

export function filterInfo(id) {
  return FILTERS.find((f) => f.id === (id || '')) || FILTERS[0];
}

/** In-season window (local date). Empty string = always. */
export function seasonNow(d = new Date()) {
  const m = d.getMonth() + 1, day = d.getDate();
  // Christmas: 1 Dec – 6 Jan
  if (m === 12 || (m === 1 && day <= 6)) return 'xmas';
  // Halloween: 20 Oct – 2 Nov
  if ((m === 10 && day >= 20) || (m === 11 && day <= 2)) return 'halloween';
  return '';
}

export function filtersForUi(d = new Date()) {
  const s = seasonNow(d);
  return FILTERS.filter((f) => !f.season || f.season === s || true); // always list; mark seasonal
}

export function filterLabel(id) {
  const f = filterInfo(id);
  return f.emoji + ' ' + t(f.key);
}

/** Build a simple three.js emoji billboard (shared geometry/materials cached). */
const cache = new Map();
export function makeFilterObject(THREE, id) {
  const f = filterInfo(id);
  if (!f.id) return null;
  if (cache.has(f.id)) return cache.get(f.id).clone();
  const c = document.createElement('canvas'); c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  g.font = '96px serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(f.emoji, 64, 72);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace || tex.colorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const spr = new THREE.Sprite(mat);
  spr.scale.set(1, 1, 1);
  spr.userData.filterId = f.id;
  spr.userData.anim = (o, t) => {
    if (f.id === 'confetti') o.material.rotation = Math.sin(t * 3) * 0.25;
    else if (f.id === 'halo') o.position.y = 0.15 + Math.sin(t * 2) * 0.04;
    else if (f.id === 'crown') o.rotation.z = Math.sin(t * 1.5) * 0.08;
    else if (f.id === 'xmas' || f.id === 'halloween') o.position.y = Math.sin(t * 2.2) * 0.05;
  };
  // Don't cache the live sprite — cache a template group
  const tmpl = new THREE.Group(); tmpl.add(spr); tmpl.userData.filterId = f.id;
  tmpl.userData.anim = (o, t) => { for (const c of o.children) if (c.userData.anim) c.userData.anim(c, t); };
  cache.set(f.id, tmpl);
  return tmpl.clone(true);
}

export function animateFilter(o, t) {
  if (o && o.userData && o.userData.anim) o.userData.anim(o, t);
}
