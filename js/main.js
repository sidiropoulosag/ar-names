import { Detector } from './detector.js';
import { Embedder } from './embedder.js';
import { Labels3D } from './labels3d.js';
import { Gallery, Tracker } from './tracker.js';
import * as db from './db.js';

const $ = (id) => document.getElementById(id);
const video = $('video'), overlay = $('overlay'), guide = $('guide');
const gctx = guide.getContext('2d');
const settings = db.loadSettings();
const detector = new Detector(), embedder = new Embedder();
const labels = new Labels3D(overlay);
const frameCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(2, 2) : document.createElement('canvas');
const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
const gallery = new Gallery();
const tracker = new Tracker(gallery, settings);
const stats = { fps: 0, det: 0, emb: 0, embN: 0, faces: 0, frames: 0, lastT: 0, detSamples: [], embSamples: [], renderSamples: [] };
let facing = 'environment', stream = null, mode = 'scan', ready = false;
window.__ar = { tracker, detector, embedder, labels, stats, settings, gallery, get mode() { return mode; }, get ready() { return ready; }, db };

function setStatus(t) { $('status').textContent = t; }

// ---------- boot ----------
async function boot() {
  try {
    setStatus('Φόρτωση μοντέλων…');
    const t0 = performance.now();
    await Promise.all([detector.init(settings.maxFaces), embedder.init(), labels.init(new URL('../fonts/dejavu_sans_bold_greek.typeface.json', import.meta.url).href)]);
    stats.loadMs = Math.round(performance.now() - t0);
    stats.delegate = detector.delegate;
    await reloadPeople();
    $('btnStart').disabled = false; $('btnStart').textContent = '📷 Άνοιγμα κάμερας';
    setStatus('Έτοιμο');
    if (new URLSearchParams(location.search).has('autostart')) start();
  } catch (e) {
    console.error(e);
    $('loadErr').textContent = 'Σφάλμα φόρτωσης: ' + (e && e.message || e);
  }
}

async function start() {
  $('start').classList.add('hidden');
  await openCamera(facing);
  stats.camStart = performance.now();
  ready = true;
  loop();
}

async function openCamera(f) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  facing = f;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false,
      video: { facingMode: { ideal: f }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
  } catch (e) {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  await new Promise((r) => (video.readyState >= 2 ? r() : video.addEventListener('loadeddata', r, { once: true })));
  const s = stream.getVideoTracks()[0].getSettings();
  const mirror = (s.facingMode || f) === 'user';
  video.classList.toggle('mirror', mirror);
  labels.mirror = mirror;
  tracker.tracks = [];
  labels.clear();
  resize();
}

function resize() {
  const W = window.innerWidth, H = window.innerHeight;
  labels.resize(W, H);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  guide.width = W * dpr; guide.height = H * dpr; gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);

// ---------- main loop ----------
let lastVideoTime = -1;
function schedule() {
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(loop);
  else requestAnimationFrame(loop);
}
function ema(old, v, a = 0.1) { return old ? old + (v - old) * a : v; }

async function loop() {
  if (!ready || !video.videoWidth) return schedule();
  if (!video.requestVideoFrameCallback && video.currentTime === lastVideoTime) return schedule();
  lastVideoTime = video.currentTime;
  const vw = video.videoWidth, vh = video.videoHeight;
  const now = performance.now();
  const t0 = now;
  let res;
  // grab the video frame ONCE into a CPU canvas; detector and embedder both read from it (one GPU->CPU readback per frame)
  if (frameCanvas.width !== vw || frameCanvas.height !== vh) { frameCanvas.width = vw; frameCanvas.height = vh; }
  frameCtx.drawImage(video, 0, 0, vw, vh);
  try { res = await detector.detect(frameCanvas, vw, vh, mode === 'scan' ? settings.range : 384); } catch (e) { console.warn(e); return schedule(); }
  const dt = performance.now() - t0;
  stats.det = ema(stats.det, dt); stats.detSamples.push(dt); if (stats.detSamples.length > 600) stats.detSamples.shift();
  if (stats.lastT) stats.fps = ema(stats.fps, 1000 / (now - stats.lastT));
  stats.lastT = now; stats.frames++;
  const tracks = tracker.update(res, vw, vh);
  stats.faces = res.faces.length;

  if (mode === 'scan') {
    // draw first, then (at most) one embedding for this frame: the two models share one WASM runtime
    const r0 = performance.now();
    labels.render(tracks, vw, vh, settings.showUnknown, now);
    const rdt = performance.now() - r0; stats.renderSamples.push(rdt); if (stats.renderSamples.length > 600) stats.renderSamples.shift();
    const t = tracker.pick();
    if (t) {
      const e0 = performance.now();
      try {
        const e = await embedder.run(embedder.crop(frameCanvas, t.kps, vw, vh));
        const ems = performance.now() - e0;
        stats.emb = ema(stats.emb, ems, 0.2); stats.embN++; stats.embSamples.push(ems); if (stats.embSamples.length > 300) stats.embSamples.shift();
        tracker.onEmbedding(t, e);
      } catch (err) { console.warn(err); }
    }
  } else {
    labels.render([], vw, vh, false, now);
    await enrollFrame(res, vw, vh);
  }
  if (settings.showStats && stats.frames % 5 === 0) {
    $('stats').textContent = `fps ${stats.fps.toFixed(0)}  πρόσωπα ${stats.faces}\nανίχνευση ${stats.det.toFixed(1)} ms (${detector.delegate})\nαναγνώριση ${stats.emb.toFixed(1)} ms/πρόσωπο`;
  }
  schedule();
}

// ---------- people ----------
async function reloadPeople() {
  const people = (await db.allPeople()).sort((a, b) => a.name.localeCompare(b.name, 'el'));
  gallery.set(people);
  tracker.relabel();
  $('peopleCount').textContent = people.length;
  $('hint').classList.toggle('hidden', people.length > 0 || mode !== 'scan');
  $('hint').textContent = 'Δεν υπάρχει κανείς ακόμα. Πάτα «＋ Νέο άτομο» για να καταχωρίσεις κάποιον.';
  renderPeople(people);
  return people;
}

function renderPeople(people) {
  const ul = $('pList'); ul.innerHTML = '';
  $('pEmpty').classList.toggle('hidden', people.length > 0);
  for (const p of people) {
    const li = document.createElement('li');
    li.innerHTML = `<img alt=""><div class="nm"></div><button data-a="add">＋ λήψεις</button><button data-a="ren">✏️</button><button data-a="del" class="danger">🗑</button>`;
    li.querySelector('img').src = p.thumb || '';
    li.querySelector('.nm').innerHTML = `${escapeHtml(p.name)}<small>${p.embeddings.length} λήψεις</small>`;
    li.querySelector('[data-a=add]').onclick = () => { closePeople(); openEnroll(p); };
    li.querySelector('[data-a=ren]').onclick = async () => {
      const n = prompt('Νέο όνομα:', p.name); if (!n || !n.trim()) return;
      p.name = n.trim(); await db.putPerson(p); await reloadPeople();
    };
    li.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm(`Διαγραφή «${p.name}»;`)) return;
      await db.deletePerson(p.id); await reloadPeople();
    };
    ul.appendChild(li);
  }
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function openPeople() { $('people').classList.remove('hidden'); }
function closePeople() { $('people').classList.add('hidden'); }

// ---------- enrollment ----------
const STEPS = [
  { msg: 'Κοίτα ευθεία στην κάμερα', ok: (p) => Math.abs(p.yaw) < 12 && Math.abs(p.pitch) < 15 },
  { msg: 'Γύρνα αργά το κεφάλι προς τη μία πλευρά', ok: (p) => Math.abs(p.yaw) > 18, sign: 'yaw' },
  { msg: 'Τώρα προς την άλλη πλευρά', ok: (p, st) => Math.abs(p.yaw) > 18 && Math.sign(p.yaw) !== st.yawSign },
  { msg: 'Σήκωσε ή κατέβασε λίγο το πηγούνι', ok: (p) => Math.abs(p.pitch) > 10, sign: 'pitch' },
  { msg: 'Τώρα αντίθετα', ok: (p, st) => Math.abs(p.pitch) > 10 && Math.sign(p.pitch) !== st.pitchSign },
];
const PER_STEP = 2, STEP_TIMEOUT = 4500;
const en = { person: null, samples: [], auto: false, step: 0, stepStart: 0, lastCap: 0, prevFacing: 'environment', busy: false, oneShot: false, st: {} };

function openEnroll(existing = null) {
  mode = 'enroll';
  en.person = existing; en.samples = []; en.auto = false; en.step = 0; en.oneShot = false; en.st = {};
  $('enName').value = existing ? existing.name : '';
  $('enName').disabled = !!existing;
  $('enThumbs').innerHTML = '';
  $('enSave').disabled = true;
  $('enroll').classList.remove('hidden');
  $('btnEnroll').classList.add('hidden');
  $('hint').classList.add('hidden');
  renderSteps();
  setMsg(existing ? `Πρόσθεσε λήψεις για «${existing.name}»` : 'Βάλε όνομα και κοίτα την κάμερα.');
  en.prevFacing = facing;
  if (facing !== 'user' && !window.__ar.keepCamera) openCamera('user');
}
async function closeEnroll() {
  mode = 'scan';
  gctx.clearRect(0, 0, guide.width, guide.height);
  $('enroll').classList.add('hidden');
  $('btnEnroll').classList.remove('hidden');
  if (en.prevFacing !== facing && !window.__ar.keepCamera) await openCamera(en.prevFacing);
  await reloadPeople();
}
function setMsg(t) { $('enMsg').textContent = t; }
function renderSteps() {
  $('enSteps').innerHTML = STEPS.map((_, i) => `<span class="${!en.auto ? '' : i < en.step ? 'done' : i === en.step ? 'now' : ''}"></span>`).join('');
}
function largest(res) {
  const f = res.faces || []; if (!f.length) return -1;
  let bi = 0, ba = 0;
  f.forEach((d, i) => { const a = (d.x1 - d.x0) * (d.y1 - d.y0); if (a > ba) { ba = a; bi = i; } });
  return bi;
}
function drawGuide(face, vw, vh, color) {
  const W = window.innerWidth, H = window.innerHeight;
  gctx.clearRect(0, 0, W, H);
  if (!face) return;
  const s = Math.max(W / vw, H / vh), ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
  let x0 = face.x0 * s + ox, x1 = face.x1 * s + ox; const y0 = face.y0 * s + oy, y1 = face.y1 * s + oy;
  if (labels.mirror) [x0, x1] = [W - x1, W - x0];
  gctx.strokeStyle = color; gctx.lineWidth = 4;
  gctx.beginPath(); gctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) * 0.62, (y1 - y0) * 0.62, 0, 0, Math.PI * 2); gctx.stroke();
}
async function capture(face, vw, vh, pose) {
  en.busy = true;
  try {
    const input = embedder.crop(frameCanvas, face.kps, vw, vh);
    const thumb = embedder.thumb();
    const e = await embedder.run(input);
    en.samples.push({ e, thumb, pose });
    const img = new Image(); img.src = thumb; $('enThumbs').appendChild(img);
    $('enSave').disabled = !$('enName').value.trim();
  } finally { en.busy = false; }
}
async function enrollFrame(res, vw, vh) {
  const i = largest(res);
  const face = i >= 0 ? res.faces[i] : null;
  const pose = face ? face.pose : null;
  drawGuide(face, vw, vh, en.auto ? '#fdd835' : '#43a047');
  if (i < 0) { if (en.auto) setMsg('Δεν βλέπω πρόσωπο…'); return; }
  const lms = face;
  const now = performance.now();
  if (en.oneShot && !en.busy) { en.oneShot = false; await capture(lms, vw, vh, pose); setMsg(`Λήψεις: ${en.samples.length}. Πάτα «Αποθήκευση».`); return; }
  if (!en.auto || en.busy) return;
  const step = STEPS[en.step];
  const taken = en.samples.filter((s) => s.step === en.step).length;
  const okPose = pose && step.ok(pose, en.st);
  const timedOut = now - en.stepStart > STEP_TIMEOUT;
  if ((okPose || (timedOut && taken === 0)) && now - en.lastCap > 220) {
    en.lastCap = now;
    if (step.sign === 'yaw' && pose) en.st.yawSign = Math.sign(pose.yaw);
    if (step.sign === 'pitch' && pose) en.st.pitchSign = Math.sign(pose.pitch);
    await capture(lms, vw, vh, pose);
    en.samples[en.samples.length - 1].step = en.step;
    const n = en.samples.filter((s) => s.step === en.step).length;
    if (n >= PER_STEP) nextStep();
  } else if (timedOut && taken > 0) nextStep();
}
function nextStep() {
  en.step++; en.stepStart = performance.now();
  if (en.step >= STEPS.length) {
    en.auto = false; renderSteps();
    setMsg(`Έτοιμο! ${en.samples.length} λήψεις. Πάτα «Αποθήκευση».`);
    $('enAuto').disabled = false;
    return;
  }
  renderSteps(); setMsg(STEPS[en.step].msg);
}
async function saveEnroll() {
  const name = $('enName').value.trim();
  if (!name || !en.samples.length) return;
  let p = en.person;
  if (!p) {
    const same = gallery.people.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (same && confirm(`Υπάρχει ήδη «${same.name}». Να προστεθούν οι λήψεις σε αυτό το άτομο;`)) p = same;
  }
  const front = en.samples.find((s) => s.pose && Math.abs(s.pose.yaw) < 12) || en.samples[0];
  if (p) { p.embeddings = [...p.embeddings, ...en.samples.map((s) => s.e)].slice(-40); if (!p.thumb) p.thumb = front.thumb; }
  else p = { id: db.newId(), name, thumb: front.thumb, created: Date.now(), embeddings: en.samples.map((s) => s.e) };
  await db.putPerson(p);
  window.__ar.lastSaved = { id: p.id, name: p.name, n: p.embeddings.length };
  await closeEnroll();
  setStatus(`Αποθηκεύτηκε: ${p.name}`);
}
async function enrollFromFiles(files) {
  for (const f of files) {
    try {
      const bmp = await createImageBitmap(f);
      const res = await detector.detect(bmp, bmp.width, bmp.height, 640);
      const i = largest(res);
      if (i < 0) { setMsg(`Δεν βρέθηκε πρόσωπο στη φωτογραφία ${f.name}`); continue; }
      const input = embedder.crop(bmp, res.faces[i].kps, bmp.width, bmp.height);
      const thumb = embedder.thumb();
      const e = await embedder.run(input);
      en.samples.push({ e, thumb, pose: null });
      const img = new Image(); img.src = thumb; $('enThumbs').appendChild(img);
    } catch (err) { console.warn(err); setMsg('Σφάλμα στη φωτογραφία: ' + err.message); }
  }
  $('enSave').disabled = !($('enName').value.trim() && en.samples.length);
  if (en.samples.length) setMsg(`Λήψεις: ${en.samples.length}. Πάτα «Αποθήκευση».`);
}

// ---------- UI wiring ----------
$('btnStart').onclick = start;
$('btnFlip').onclick = () => openCamera(facing === 'user' ? 'environment' : 'user');
$('btnEnroll').onclick = () => openEnroll();
$('btnPeople').onclick = openPeople;
$('pClose').onclick = closePeople;
$('enCancel').onclick = closeEnroll;
$('enSave').onclick = saveEnroll;
$('enName').oninput = () => { $('enSave').disabled = !($('enName').value.trim() && en.samples.length); };
$('enAuto').onclick = () => {
  en.auto = true; en.step = 0; en.stepStart = performance.now(); en.st = {};
  $('enAuto').disabled = true; renderSteps(); setMsg(STEPS[0].msg);
};
$('enOne').onclick = () => { en.oneShot = true; };
$('enFile').onchange = (ev) => { enrollFromFiles([...ev.target.files]); ev.target.value = ''; };
$('pExport').onclick = async () => {
  const blob = new Blob([await db.exportJSON()], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `ar-names-backup-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.appendChild(a); a.click(); a.remove();
};
$('pImport').onchange = async (ev) => {
  const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
  try { const n = await db.importJSON(await f.text()); alert(`Εισήχθησαν ${n} άτομα.`); await reloadPeople(); }
  catch (e) { alert('Σφάλμα: ' + e.message); }
};
$('pClear').onclick = async () => {
  if (!confirm('Διαγραφή ΟΛΩΝ των ατόμων; Δεν αναιρείται.')) return;
  await db.clearAll(); await reloadPeople();
};
const thr = $('thr');
thr.value = settings.threshold; $('thrVal').textContent = settings.threshold.toFixed(2);
thr.oninput = () => { settings.threshold = +thr.value; $('thrVal').textContent = settings.threshold.toFixed(2); db.saveSettings(settings); tracker.relabel(); };
$('optRange').value = String(settings.range);
$('optRange').onchange = (e) => { settings.range = +e.target.value; db.saveSettings(settings); };
$('optUnknown').checked = settings.showUnknown;
$('optUnknown').onchange = (e) => { settings.showUnknown = e.target.checked; db.saveSettings(settings); };
$('optStats').checked = settings.showStats;
$('stats').classList.toggle('hidden', !settings.showStats);
$('optStats').onchange = (e) => { settings.showStats = e.target.checked; db.saveSettings(settings); $('stats').classList.toggle('hidden', !settings.showStats); };

// Service worker (sw.js: offline cache + COOP/COEP headers) is registered by coi-serviceworker.js,
// which also reloads once so the page becomes crossOriginIsolated (multi-threaded WASM) on GitHub Pages.
// Fallback: if the worker took control only after this page loaded, reload once before the camera starts.
if ('serviceWorker' in navigator && !self.crossOriginIsolated) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!stream && !sessionStorage.getItem('arCoiReload')) { sessionStorage.setItem('arCoiReload', '1'); location.reload(); }
  });
} else if (self.crossOriginIsolated) sessionStorage.removeItem('arCoiReload');
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  $('loadErr').textContent = 'Η κάμερα χρειάζεται σύνδεση HTTPS και σύγχρονο browser (Safari / Chrome).';
}
boot();
