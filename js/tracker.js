// Multi-face tracking + recognition scheduling.
// v47: a recognised name stays locked on that person when the face turns away;
// we keep following the head for a few seconds and never swap names if unsure.
import { iou } from './geometry.js';
import { HeadLock, HOLD_MS, FADE_MS, boxCenter, boxDist, shiftTrack } from './headlock.js';

export class Gallery {
  constructor() { this.people = []; this.mat = new Float32Array(0); this.owner = new Int32Array(0); this.dim = 128; }
  set(people) {
    this.people = people;
    let n = 0; for (const p of people) n += p.embeddings.length;
    this.mat = new Float32Array(n * this.dim); this.owner = new Int32Array(n);
    let k = 0;
    people.forEach((p, pi) => { for (const e of p.embeddings) { this.mat.set(e, k * this.dim); this.owner[k++] = pi; } });
  }
  // returns per-person best cosine similarity, sorted desc: [{pi, sim}]
  match(e) {
    const best = new Float32Array(this.people.length).fill(-1);
    const d = this.dim, m = this.mat;
    for (let k = 0; k < this.owner.length; k++) {
      let s = 0; const o = k * d;
      for (let i = 0; i < d; i++) s += m[o + i] * e[i];
      if (s > best[this.owner[k]]) best[this.owner[k]] = s;
    }
    const out = [];
    for (let i = 0; i < best.length; i++) out.push({ pi: i, sim: best[i] });
    out.sort((a, b) => b.sim - a.sim);
    return out;
  }
}

let nextId = 1;
const REVERIFY_FRAMES = 12;   // re-check a labelled face every ~12 frames
const RETRY_FRAMES = 2;       // retry an unknown face every 2 frames
const MAX_MISSED = 6;         // unlabelled tracks: keep alive for 6 frames without a face
const IOU_MIN = 0.15;
const LOCK_DIST = 0.75;       // how far (in box-diagonals) a reappearing face may be from a lock
const AMBIG_GAP = 0.12;       // if two matches are this close, do not guess

export { HOLD_MS, FADE_MS };

export class Tracker {
  constructor(gallery, settings) {
    this.gallery = gallery; this.settings = settings;
    this.tracks = []; this.frame = 0;
    this.lock = new HeadLock();
    this._now = 0;
  }
  update(result, vw, vh, frame, now = performance.now()) {
    this.frame++;
    const dt = Math.min(120, now - (this._now || now)) || 16;
    this._now = now;
    const dets = (result.faces || []).map((f) => ({ kps: f.kps, box: f.box, pose: f.pose, wpx: f.wpx, score: f.score, det: f }));

    const scoreOf = (t, d) => {
      const v = iou(t.box, d.box);
      const dist = boxDist(t.box, d.box);
      const locked = !!t.label;
      if (v < IOU_MIN && !(locked && dist < LOCK_DIST)) return 0;
      return locked ? Math.max(v, 1 - dist) : v;
    };
    const pairs = [];
    this.tracks.forEach((t, ti) => dets.forEach((d, di) => {
      const s = scoreOf(t, d); if (s > 0) pairs.push([s, ti, di]);
    }));
    pairs.sort((a, b) => b[0] - a[0]);

    // for each detection, the best and second-best track scores (to catch crossings)
    const bestForD = [], secondForD = [];
    for (const [s, ti, di] of pairs) {
      if (bestForD[di] === undefined) bestForD[di] = [s, ti];
      else if (secondForD[di] === undefined) secondForD[di] = [s, ti];
    }
    const usedT = new Set(), usedD = new Set(), ambigT = new Set();
    for (const [s, ti, di] of pairs) {
      if (usedT.has(ti) || usedD.has(di)) continue;
      const sec = secondForD[di];
      const t = this.tracks[ti], other = sec && this.tracks[sec[1]];
      // two named people could both claim this face: do not swap, fade both
      if (t.label && other && other.label && other.id !== t.id && sec[0] > s - AMBIG_GAP && sec[0] > 0.35) {
        ambigT.add(ti); ambigT.add(sec[1]);
        usedD.add(di);   // this face stays unassigned this frame
        continue;
      }
      usedT.add(ti); usedD.add(di);
      this._acquire(this.tracks[ti], dets[di], now, dt, frame, vw, vh);
    }
    for (const ti of ambigT) {
      const t = this.tracks[ti];
      t.ambig = true;
      t.coast = true;
      t.labelAlpha = Math.min(t.labelAlpha == null ? 1 : t.labelAlpha, 0.2);
      t.lockConf = Math.min(t.lockConf == null ? 1 : t.lockConf, 0.2);
    }

    this.tracks.forEach((t, ti) => { if (!usedT.has(ti)) this._coast(t, frame, vw, vh, dt, now); });

    dets.forEach((d, di) => {
      if (usedD.has(di)) return;
      // a leftover face very close to one unmatched named track still belongs to it
      let near = -1, nearD = 9, second = 9;
      this.tracks.forEach((t, ti) => {
        if (usedT.has(ti) || !t.label) return;
        const dist = boxDist(t.box, d.box);
        if (dist < nearD) { second = nearD; nearD = dist; near = ti; }
        else if (dist < second) second = dist;
      });
      if (near >= 0 && nearD < LOCK_DIST && second - nearD >= 0.25) {
        usedT.add(near); usedD.add(di);
        this._acquire(this.tracks[near], d, now, dt, frame, vw, vh);
        return;
      }
      if (near >= 0 && nearD < LOCK_DIST && second < LOCK_DIST) {
        // two named tracks equally close: fade rather than guess
        this.tracks.forEach((t, ti) => {
          if (usedT.has(ti) || !t.label) return;
          if (boxDist(t.box, d.box) < LOCK_DIST) {
            t.ambig = true; t.coast = true;
            t.labelAlpha = Math.min(t.labelAlpha == null ? 1 : t.labelAlpha, 0.2);
          }
        });
        return;
      }
      this.tracks.push({ id: nextId++, ...d, missed: 0, seen: 1, label: null, pi: -1, sim: 0, scores: new Map(),
        lastEmbed: -999, embeds: 0, born: now, recognisedAt: 0, smooth: null,
        faceAt: now, goodAt: now, vx: 0, vy: 0, cx: boxCenter(d.box).x, cy: boxCenter(d.box).y,
        locked: false, coast: false, lockConf: 1, labelAlpha: 1, ambig: false });
    });

    this._uniquePeople();
    this.tracks = this.tracks.filter((t) => !this._shouldDrop(t, now));
    return this.tracks;
  }

  _acquire(t, d, now, dt, frame, vw, vh) {
    const prev = t.box;
    Object.assign(t, d, { missed: 0, seen: t.seen + 1, coast: false, ambig: false, lockConf: 1, labelAlpha: 1 });
    const c = boxCenter(t.box);
    const ms = Math.max(8, dt);
    if (prev) {
      t.vx = 0.5 * (t.vx || 0) + 0.5 * (c.x - boxCenter(prev).x) / ms;
      t.vy = 0.5 * (t.vy || 0) + 0.5 * (c.y - boxCenter(prev).y) / ms;
    }
    t.cx = c.x; t.cy = c.y;
    t.faceAt = now; t.goodAt = now;
    t.locked = !!t.label;
    if (t.label && frame) this.lock.remember(frame, t, vw, vh);
  }

  _coast(t, frame, vw, vh, dt, now) {
    t.missed++;
    if (!t.label) { t.locked = false; t.coast = false; t.labelAlpha = 0; return; }
    t.coast = true;
    t.locked = true;
    let conf = 0;
    if (frame) {
      try { conf = this.lock.follow(frame, t, vw, vh, dt); } catch (_) { conf = 0; }
    } else {
      shiftTrack(t, (t.vx || 0) * dt, (t.vy || 0) * dt, vw, vh);
      conf = Math.max(0, (t.lockConf || 0) * 0.85);
    }
    t.lockConf = conf;
    if (conf >= 0.45) t.goodAt = now;
    const lostFor = now - (t.goodAt || t.faceAt || now);
    let alpha = 1;
    if (lostFor > HOLD_MS - FADE_MS) alpha = Math.max(0, (HOLD_MS - lostFor) / FADE_MS);
    if (t.ambig) alpha = Math.min(alpha, 0.2);
    t.labelAlpha = alpha;
    t.locked = alpha > 0.12;
  }

  _shouldDrop(t, now) {
    if (!t.label) return t.missed > MAX_MISSED;
    const lostFor = now - (t.goodAt || t.faceAt || now);
    if (lostFor > HOLD_MS) return true;
    const b = t.box;
    const on = b && b.x1 > 0.02 && b.x0 < 0.98 && b.y1 > 0.02 && b.y0 < 0.98;
    if (!on && lostFor > 600) return true;
    return false;
  }

  // one name on one track; if a duplicate appears, keep the one with a live face (or the newer lock)
  _uniquePeople() {
    const by = new Map();
    for (const t of this.tracks) {
      if (!t.label || t.personId == null) continue;
      const k = 'p' + t.personId;
      const cur = by.get(k);
      if (!cur) { by.set(k, t); continue; }
      const better = (t.missed - cur.missed) || ((cur.recognisedAt || 0) - (t.recognisedAt || 0));
      const drop = better < 0 ? cur : t;
      const keep = drop === t ? cur : t;
      by.set(k, keep);
      drop.label = null; drop.pi = -1; drop.personId = null; drop.locked = false;
      drop.message = ''; drop.objectId = ''; drop.labelAlpha = 0;
    }
  }

  // choose which visible track should get an embedding this frame (or null)
  pick(filter = null) {
    if (!this.gallery.people.length) return null;
    let best = null, bestPri = -Infinity;
    for (const t of this.tracks) {
      if (filter && !filter(t)) continue;
      if (t.missed > 0 || t.wpx < 36 || Math.abs(t.pose.yaw) > 75) continue;
      const age = this.frame - t.lastEmbed;
      let pri;
      if (!t.label) { if (age < (t.embeds < 5 ? RETRY_FRAMES : 8)) continue; pri = 1000 - t.embeds * 10 + age; }
      else { if (age < REVERIFY_FRAMES) continue; pri = age; }
      if (pri > bestPri) { bestPri = pri; best = t; }
    }
    return best;
  }
  // feed an embedding result for track t
  onEmbedding(t, e) {
    t.lastEmbed = this.frame; t.embeds++;
    const ranked = this.gallery.match(e);
    const thr = this.settings.threshold, margin = this.settings.margin;
    const frontal = Math.abs(t.pose.yaw) < 40 && Math.abs(t.pose.pitch) < 30;
    for (const { pi, sim } of ranked.slice(0, 5)) {
      const prev = t.scores.get(pi);
      t.scores.set(pi, prev === undefined ? sim : 0.5 * prev + 0.5 * sim);
    }
    // decay people that were not in top-5
    for (const [pi, s] of t.scores) if (!ranked.slice(0, 5).some((r) => r.pi === pi)) t.scores.set(pi, s * 0.7);
    const sc = [...t.scores.entries()].sort((a, b) => b[1] - a[1]);
    const [bpi, bs] = sc[0] || [-1, -1];
    const second = sc[1] ? sc[1][1] : -1;
    const raw = ranked[0];
    t.lastRaw = raw ? raw.sim : 0;
    const confident = bs >= thr && bs - second >= margin;
    if (!t.label) {
      // instant accept on a strong single match, otherwise need 2 agreeing frames
      if ((raw && raw.pi === bpi && raw.sim >= thr + 0.08 && raw.sim - (ranked[1] ? ranked[1].sim : -1) >= margin) || (confident && t.embeds >= 2)) {
        this.setLabel(t, bpi, bs);
      }
    } else if (bpi !== t.pi && confident && bs > (t.scores.get(t.pi) || 0) + margin) {
      this.setLabel(t, bpi, bs); // switch identity
    } else {
      const own = t.scores.get(t.pi) || 0;
      t.sim = own;
      // only drop a label on a good-quality (near-frontal) view that clearly fails
      if (frontal && own < thr - 0.08) { t.label = null; t.pi = -1; t.personId = null; t.locked = false; }
    }
  }
  setLabel(t, pi, sim) {
    const p = this.gallery.people[pi];
    if (!p) return;
    t.pi = pi; t.label = p.name; t.personId = p.id; t.sim = sim;
    t.locked = true; t.labelAlpha = 1; t.ambig = false;
    if (!t.recognisedAt) t.recognisedAt = performance.now();
  }
  relabel() { // after gallery change
    for (const t of this.tracks) {
      t.label = null; t.pi = -1; t.scores.clear(); t.embeds = 0; t.lastEmbed = -999; t.recognisedAt = 0;
      t.locked = false; t.coast = false; t.labelAlpha = 1; t.ambig = false; t.personId = null;
    }
  }
}
