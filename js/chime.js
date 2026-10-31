// One soft, synthesised chime per recognition round (no audio files). WebAudio only; silently
// does nothing on browsers without it. The context is created/unlocked on the «Άνοιγμα κάμερας» tap.
let ctx = null;
export const chimeStats = { played: 0, unlocked: false, lastAt: 0 };
export function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!ctx) ctx = new AC();
    if (ctx.state !== 'running' && ctx.state !== 'closed' && ctx.resume) ctx.resume().catch(() => {});   // iOS: 'suspended' or 'interrupted'
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

// v21: a soft camera "shutter" for the screenshot button (only when «Ήχος αναγνώρισης» is on).
// Synthesised: a tiny band-passed noise tick followed by a gentle low click. Very quiet.
export function playShutter(volume = 0.05) {
  if (!ctx || ctx.state === 'closed') return false;
  try {
    if (ctx.state !== 'running' && ctx.state !== 'closed' && ctx.resume) ctx.resume().catch(() => {});   // iOS: 'suspended' or 'interrupted'
    const t0 = ctx.currentTime + 0.005, sr = ctx.sampleRate, len = Math.floor(sr * 0.09);
    const b = ctx.createBuffer(1, len, sr), d = b.getChannelData(0);
    for (let i = 0; i < len; i++) { const t = i / len; d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3); }
    const src = ctx.createBufferSource(); src.buffer = b;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 0.8;
    const g = ctx.createGain(); g.gain.setValueAtTime(volume, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
    src.connect(bp); bp.connect(g); g.connect(ctx.destination); src.start(t0); src.stop(t0 + 0.1);
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(520, t0 + 0.05); o.frequency.exponentialRampToValueAtTime(300, t0 + 0.12);
    og.gain.setValueAtTime(0.0001, t0 + 0.05); og.gain.exponentialRampToValueAtTime(volume * 0.8, t0 + 0.06); og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
    o.connect(og); og.connect(ctx.destination); o.start(t0 + 0.05); o.stop(t0 + 0.16);
    chimeStats.shutter = (chimeStats.shutter || 0) + 1;
    return true;
  } catch (e) { return false; }
}

// v24: a soft "ping" for a received heart / message (only when «Ήχος αναγνώρισης» is on): three light notes.
export function playPing(volume = 0.06) {
  chimeStats.pings = (chimeStats.pings || 0) + 1;
  if (!ctx || ctx.state === 'closed') return false;
  try {
    if (ctx.state !== 'running' && ctx.state !== 'closed' && ctx.resume) ctx.resume().catch(() => {});   // iOS: 'suspended' or 'interrupted'
    const t0 = ctx.currentTime + 0.01;
    const out = ctx.createGain(); out.gain.value = volume; out.connect(ctx.destination);
    for (const [f, dt, len] of [[783.99, 0, 0.5], [1046.5, 0.09, 0.6], [1318.5, 0.18, 0.9]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(1, t0 + dt + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + len);
      o.connect(g); g.connect(out); o.start(t0 + dt); o.stop(t0 + dt + len + 0.05);
    }
    return true;
  } catch (e) { return false; }
}
// v26 iOS: resume a context that iOS suspended / interrupted (call, Siri, background); call from a touch handler
export function resumeAudio() {
  try { if (ctx && ctx.state !== 'running' && ctx.state !== 'closed' && ctx.resume) ctx.resume().catch(() => {}); } catch (e) { /* ignore */ }
}
export const audioState = () => (ctx ? ctx.state : 'none');
