// One soft, synthesised chime per recognition round (no audio files). WebAudio only; silently
// does nothing on browsers without it. The context is created/unlocked on the «Άνοιγμα κάμερας» tap.
let ctx = null;
export const chimeStats = { played: 0, unlocked: false, lastAt: 0 };
export function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
    // a silent 1-sample buffer: unlocks iOS Safari inside the user gesture
    const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource();
    s.buffer = b; s.connect(ctx.destination); s.start(0);
    chimeStats.unlocked = true;
  } catch (e) { /* no audio: fine */ }
}
export function playChime(volume = 0.07) {
  chimeStats.played++; chimeStats.lastAt = performance.now();
  if (!ctx || ctx.state === 'closed') return false;
  try {
    const t0 = ctx.currentTime + 0.01;
    const out = ctx.createGain(); out.gain.value = volume; out.connect(ctx.destination);
    // two gentle sine notes (E5 -> A5): fast attack, smooth exponential fade
    for (const [f, dt, len] of [[659.25, 0, 0.9], [880, 0.13, 1.1]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(1, t0 + dt + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + len);
      o.connect(g); g.connect(out); o.start(t0 + dt); o.stop(t0 + dt + len + 0.05);
    }
    return true;
  } catch (e) { return false; }
}

// Round logic: a chime when >=1 person is newly shown; several people in one round (or within
// GROUP_MS) = one chime; global COOLDOWN_MS; a person still / recently on screen never re-chimes.
export const GROUP_MS = 1200, COOLDOWN_MS = 3000, FORGET_MS = 30000;
export class ChimeRounds {
  constructor(play = playChime) { this.play = play; this.seen = new Map(); this.last = -Infinity; }
  // keys: ids of the people recognised & shown right now; returns true when it chimed
  update(keys, now, enabled = true) {
    let fresh = 0;
    for (const k of keys) { if (!this.seen.has(k)) fresh++; this.seen.set(k, now); }
    for (const [k, at] of this.seen) if (now - at > FORGET_MS) this.seen.delete(k);
    if (!fresh || !enabled) return false;
    if (now - this.last < Math.max(COOLDOWN_MS, GROUP_MS)) return false;
    this.last = now; this.play(); return true;
  }
}
