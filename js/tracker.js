// Multi-face tracking + recognition scheduling.
import { iou } from './geometry.js';

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
const MAX_MISSED = 6;         // keep a track alive for 6 frames without detection

export class Tracker {
  constructor(gallery, settings) {
    this.gallery = gallery; this.settings = settings;
    this.tracks = []; this.frame = 0;
  }
  update(result, vw, vh) {
    this.frame++;
    const dets = (result.faces || []).map((f) => ({ kps: f.kps, box: f.box, pose: f.pose, wpx: f.wpx, score: f.score, det: f }));
    // greedy IoU matching
    const pairs = [];
    this.tracks.forEach((t, ti) => dets.forEach((d, di) => {
      const v = iou(t.box, d.box); if (v > 0.15) pairs.push([v, ti, di]);
    }));
    pairs.sort((a, b) => b[0] - a[0]);
    const usedT = new Set(), usedD = new Set();
    for (const [, ti, di] of pairs) {
      if (usedT.has(ti) || usedD.has(di)) continue;
      usedT.add(ti); usedD.add(di);
      Object.assign(this.tracks[ti], dets[di], { missed: 0, seen: this.tracks[ti].seen + 1 });
    }
    this.tracks.forEach((t, ti) => { if (!usedT.has(ti)) t.missed++; });
    dets.forEach((d, di) => {
      if (usedD.has(di)) return;
      this.tracks.push({ id: nextId++, ...d, missed: 0, seen: 1, label: null, pi: -1, sim: 0, scores: new Map(),
        lastEmbed: -999, embeds: 0, born: performance.now(), recognisedAt: 0, smooth: null });
    });
    this.tracks = this.tracks.filter((t) => t.missed <= MAX_MISSED);
    return this.tracks;
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
      if (frontal && own < thr - 0.08) { t.label = null; t.pi = -1; }
    }
  }
  setLabel(t, pi, sim) {
    const p = this.gallery.people[pi];
    if (!p) return;
    t.pi = pi; t.label = p.name; t.personId = p.id; t.sim = sim;
    if (!t.recognisedAt) t.recognisedAt = performance.now();
  }
  relabel() { // after gallery change
    for (const t of this.tracks) { t.label = null; t.pi = -1; t.scores.clear(); t.embeds = 0; t.lastEmbed = -999; t.recognisedAt = 0; }
  }
}
