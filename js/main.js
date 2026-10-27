import { Detector } from './detector.js';
import { Embedder } from './embedder.js';
import { Labels3D } from './labels3d.js';
import { Gallery, Tracker } from './tracker.js';
import * as db from './db.js';
import * as server from './server.js';
import { OBJECTS, objectInfo, previewObject, DEFAULT_OBJECT, assetUrl } from './objects3d.js';
let dispMulti = false, dispDirty = false;   // «Τι δείχνω»: 2 choices allowed (0.4.0) / unsaved edits

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
const cfg = server.loadCfg();
const api = new server.Api(cfg);
window.__ar = { cfg, api, get srv() { return srv; }, get caps() { return caps; }, get adv() { return adv; }, tracker, detector, embedder, labels, stats, settings, gallery, get mode() { return mode; }, get fam() { return fam; }, get ready() { return ready; }, db };

function setStatus(t) { $('status').textContent = t; }

// ---------- advanced mode (hidden): tap «Ρυθμίσεις» 7 times ----------
// Normal users never see the server address, the token or the names of people who are not online.
let adv = localStorage.getItem('ar-names-adv') === '1';
function applyAdv() { document.body.classList.toggle('adv', adv); }
applyAdv();
{
  let taps = 0, first = 0;
  $('setTitle').addEventListener('click', () => {
    const now = Date.now();
    if (now - first > 4000) { taps = 0; first = now; }
    if (++taps < 7) return;
    taps = 0; adv = !adv; adv ? localStorage.setItem('ar-names-adv', '1') : localStorage.removeItem('ar-names-adv');
    applyAdv();
    const n = $('advNote'); n.textContent = adv ? '🔧 Προχωρημένες ρυθμίσεις: ενεργές' : 'Προχωρημένες ρυθμίσεις: κρυφές';
    n.classList.remove('hidden'); setTimeout(() => n.classList.add('hidden'), 3000);
    renderPeople(); if (cfg.url) refreshServer(); else syncServerUi();
  });
}
// Server error in words a normal user understands (no "token", no addresses).
function errMsg(e) {
  if (!adv && e && (e.code === 'bad_token' || e.code === 'auth_required')) return 'το προφίλ σου δεν βρέθηκε στον server';
  if (!adv && e && (e.code === 'offline' || e.code === 'timeout')) return 'εκτός σύνδεσης';
  return server.errEl(e);
}

// ---------- server capabilities (from /health) ----------
// 0.3.0+: features ['display','presence']; older servers have no 'features' -> message only, no online list.
let caps = null; // null = unknown, else { version, features:Set }
function noteHealth(h) { caps = { version: h.version || '', features: new Set(h.features || []) }; return h; }
const hasCap = (f) => !!(caps && caps.features.has(f));
// presence heartbeat: tells the server "I'm here" so others see me as online (recognition calls count too)
setInterval(() => {
  if (!document.hidden && cfg.url && cfg.token && hasCap('presence')) api.presence().catch(() => {});
}, 60000);

// ---------- boot ----------
async function boot() {
  try {
    setStatus('Φόρτωση μοντέλων…');
    const t0 = performance.now();
    await Promise.all([detector.init(settings.maxFaces), embedder.init(), labels.init(new URL('../fonts/dejavu_sans_bold_greek.typeface.json', import.meta.url).href)]);
    stats.loadMs = Math.round(performance.now() - t0);
    stats.delegate = detector.delegate;
    await reloadPeople();
    refreshFamily();
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
    let useLocal = true, filter = null;
    if (serverOn()) {
      await serverStep(tracks, vw, vh, now); useLocal = srv.offline;
      // people saved only on this phone keep working: faces the server doesn't know are matched locally too
      if (!useLocal && gallery.people.length) { useLocal = true; filter = (x) => !x.srv && (x.srvMiss || 0) >= 1; }
    }
    const t = useLocal ? tracker.pick(filter) : null;
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
  renderBubbles();
  schedule();
}

// ---------- people ----------
let localPeople = [];
// Family members on the server (shown in the main list next to the people stored on this phone).
// mode: 'member' = full list via GET /people (this device has a person token),
//       'public' = names + ready status via GET /people/public (server has ARN_PUBLIC_LIST=1),
//       'count'  = only the number of people (from /health) + a hint to sign in.
const fam = { people: null, count: null, mode: '', err: '', at: 0, busy: false, timer: 0 };

async function reloadPeople() {
  const people = (await db.allPeople()).sort((a, b) => a.name.localeCompare(b.name, 'el'));
  localPeople = people;
  gallery.set(people);
  tracker.relabel();
  $('hint').classList.toggle('hidden', people.length > 0 || mode !== 'scan' || serverOn());
  $('hint').textContent = 'Δεν υπάρχει κανείς ακόμα. Πάτα «＋ Νέο άτομο» για να καταχωρίσεις κάποιον.';
  renderPeople();
  return people;
}

async function famFromPublic() {
  const h = noteHealth(await api.health(6000));
  if (h.public_list) {
    const r = await api.peoplePublic();
    Object.assign(fam, { people: r.people, count: r.count, mode: 'public', onlineOnly: !!r.online_only, onlineCount: r.online_count });
  } else Object.assign(fam, { people: null, count: h.people, mode: 'count' });  // older server or list turned off
}
async function refreshFamily() {
  if (!cfg.url) { Object.assign(fam, { people: null, count: null, mode: '', err: '' }); renderPeople(); return; }
  if (fam.busy) return;
  fam.busy = true;
  try {
    if (cfg.token) {
      try {
        if (!caps) try { noteHealth(await api.health(6000)); } catch (e) { /* the list call below reports it */ }
        const { people } = await api.people(); Object.assign(fam, { people, count: people.length, mode: 'member' });
        if (cfg.personId == null) { const me = await api.me(); cfg.personId = me.id; cfg.name = me.name; server.saveCfg(cfg); }
      }
      catch (e) { if (e.status !== 401) throw e; await famFromPublic(); }   // token no longer valid
    } else await famFromPublic();
    fam.err = '';
  } catch (e) { fam.err = server.errEl(e); }
  finally { fam.busy = false; fam.at = Date.now(); renderPeople(); }
}
const plural = (n) => `${n} ${n === 1 ? 'άτομο' : 'άτομα'}`;

function renderPeople() {
  const people = localPeople;
  const ul = $('pList'); ul.innerHTML = '';
  const norm = (x) => (x || '').trim().toLocaleLowerCase('el');
  const isMe = (sp) => fam.mode === 'member' && sp.id != null && sp.id === cfg.personId;
  // normal users: only people who are online now (+ yourself); older servers send no 'online' -> no other names
  const srvList = ((cfg.url && fam.people) || []).filter((sp) => adv || sp.online === true || isMe(sp));
  const matched = new Set();
  const srvTag = (sp) => adv
    ? `☁️ server · ${sp.active ? 'ενεργό' : 'ανολοκλήρωτο'}${sp.online ? ' · 🟢 online' : ''}${isMe(sp) ? ' · εσύ' : ''}${dispTag(sp.display)}`
    : `☁️ ${isMe(sp) ? 'εσύ' : '🟢 online τώρα'}${dispTag(sp.display)}`;
  for (const p of people) {
    const sp = srvList.find((x) => !matched.has(x) && norm(x.name) === norm(p.name));   // same person on phone + server: one row
    if (sp) matched.add(sp);
    const li = document.createElement('li');
    li.innerHTML = `<img alt=""><div class="nm"></div><button data-a="add">＋ λήψεις</button><button data-a="ren">✏️</button><button data-a="del" class="danger">🗑</button>`;
    li.querySelector('img').src = p.thumb || '';
    li.querySelector('.nm').innerHTML = `${escapeHtml(p.name)}<small>${p.embeddings.length} λήψεις σε αυτή τη συσκευή${sp ? ' · ' + escapeHtml(srvTag(sp)) : ''}</small>`;
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
  let srvOnly = 0;
  for (const sp of srvList) {
    if (matched.has(sp)) continue;
    srvOnly++;
    const me = isMe(sp);
    const li = document.createElement('li'); li.className = 'srv' + (me ? ' me' : '');
    li.innerHTML = '<div class="av">☁️</div><div class="nm"></div>';
    li.querySelector('.nm').innerHTML = `${escapeHtml(sp.name)}<small>${escapeHtml(srvTag(sp))}</small>`;
    ul.appendChild(li);
  }
  $('pEmpty').classList.toggle('hidden', ul.children.length > 0);
  syncEnrollBtn();
  $('peopleCount').textContent = people.length + srvOnly;
  const fc = $('famCount');
  let t = '';
  const online = (fam.people || []).filter((sp) => sp.online === true).length;
  const knowsOnline = fam.mode === 'public' ? fam.onlineOnly : (fam.people || []).some((sp) => 'online' in sp);
  if (cfg.url && fam.count != null && !adv) {
    if (knowsOnline || fam.mode === 'public') t = `☁️ Συνδεδεμένος ✓ · Online τώρα: ${fam.mode === 'public' ? (fam.onlineCount ?? online) : online}`;
    else t = `☁️ Συνδεδεμένος ✓ · Οικογένεια: ${plural(fam.count)}`;
    if (fam.mode === 'count' && !cfg.token && fam.count > 0) t += '. Για να δεις ποιος είναι online, καταχώρισε τον εαυτό σου («＋ Νέο άτομο»).';
    if (fam.err) t = `☁️ Εκτός σύνδεσης — φαίνεται η τελευταία λίστα (${fam.err})`;
  } else if (cfg.url && fam.count != null) {
    const onlyHere = people.length - matched.size;
    t = `Οικογένεια: ${plural(fam.count)}` + (fam.mode !== 'count' && onlyHere > 0 ? ` · ${plural(onlyHere)} μόνο σε αυτή τη συσκευή` : '');
    if (fam.mode === 'count' && fam.count > 0) t += ' στον server. Για να δεις ποιοι είναι, συνδέσου: καταχώρισε τον εαυτό σου («＋ Νέο άτομο») ή βάλε το token σου στις ρυθμίσεις.';
    if (fam.err) t += ` (⚠️ ${fam.err} — δείχνω την τελευταία λίστα)`;
  } else if (cfg.url && fam.err) t = adv ? `☁️ Ο server της οικογένειας δεν απαντά τώρα (${fam.err}) — φαίνονται μόνο τα άτομα αυτής της συσκευής.`
    : '☁️ Εκτός σύνδεσης — φαίνονται μόνο τα άτομα αυτής της συσκευής.';
  fc.textContent = t; fc.classList.toggle('hidden', !t);
}
// what a person chose to show (only present when they allow you to see it)
// what a viewer shows for one person, from any server version's `display`
const ITEM_OF_MODE = { message: 'message1', message2: 'message2', object3d: 'object3d' };
function viewOf(d) {
  const items = Array.isArray(d.items) && d.items.length ? d.items : ['name', ITEM_OF_MODE[d.mode] || 'message1'];
  const texts = [];
  if (d.items) { for (const k of ['message1', 'message2']) if (items.includes(k) && d[k]) texts.push(d[k]); }
  else if (d.mode !== 'object3d' && d.text) texts.push(d.text);
  const sz = d.sizes || {};
  return { items, showName: items.includes('name'), text: texts.join('\n'),
    objectId: items.includes('object3d') ? (d.object_id || DEFAULT_OBJECT) : '',
    sizes: d.sizes ? { name: +sz.name || 1, text: +sz.text || 1, object: +sz.object || 1 } : null };
}
function dispTag(d) {
  if (!d) return '';
  const v = viewOf(d), out = [];
  if (v.objectId) { const o = objectInfo(v.objectId); out.push(`δείχνει ${o.emoji} ${o.name}`); }
  if (v.text) { const t = v.text.replace(/\n/g, ' · '); out.push(`💬 «${t.length > 40 ? t.slice(0, 40) + '…' : t}»`); }
  if (d.items && !v.showName) out.push('χωρίς όνομα');
  return out.length ? ' · ' + out.join(' · ') : '';
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function openPeople() {
  $('people').classList.remove('hidden');
  refreshFamily(); clearInterval(fam.timer);
  fam.timer = setInterval(() => { if (!document.hidden) refreshFamily(); }, 15000);   // live while the list is open
}
// «＋ Νέο άτομο» only until this device has its owner's profile (server token, or the on-device «me» person);
// afterwards adding / re-enrolling is in Settings («Προσθήκη νέου προφίλ») and in advanced mode.
function hasOwnProfile() { return !!cfg.token || (localPeople || []).some((p) => p.me); }
function syncEnrollBtn() {
  const own = hasOwnProfile();
  $('btnEnroll').classList.toggle('hidden', own || mode === 'enroll');
  $('pAddNew').classList.toggle('hidden', !own);
}
function closePeople() { $('people').classList.add('hidden'); clearInterval(fam.timer); fam.timer = 0; }
function famOnFocus() { if (!document.hidden && Date.now() - fam.at > 3000) refreshFamily(); }
document.addEventListener('visibilitychange', famOnFocus);
window.addEventListener('focus', famOnFocus);

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
  en.steps = STEPS; en.srvMode = false;
  $('enroll').classList.remove('hidden');
  $('btnEnroll').classList.add('hidden');
  $('hint').classList.add('hidden');
  renderSteps();
  setMsg(existing ? `Πρόσθεσε λήψεις για «${existing.name}»` : 'Βάλε όνομα και κοίτα την κάμερα.');
  setupEnrollServer(existing);
  en.prevFacing = facing;
  if (facing !== 'user' && !window.__ar.keepCamera) openCamera('user');
}
async function closeEnroll() {
  mode = 'scan';
  gctx.clearRect(0, 0, guide.width, guide.height);
  $('enroll').classList.add('hidden');
  syncEnrollBtn();
  if (en.prevFacing !== facing && !window.__ar.keepCamera) await openCamera(en.prevFacing);
  await reloadPeople();
}
function setMsg(t) { $('enMsg').textContent = t; }
function renderSteps() {
  $('enSteps').innerHTML = en.steps.map((_, i) => `<span class="${!en.auto ? '' : i < en.step ? 'done' : i === en.step ? 'now' : ''}"></span>`).join('');
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
    const blob = enrollToServer() ? await frameJpeg(face, vw, vh) : null;
    const e = await embedder.run(input);
    const img = new Image(); img.src = thumb; $('enThumbs').appendChild(img);
    en.samples.push({ e, thumb, pose, blob, el: img, label: server.classifyPose(pose) });
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
  if (en.srvMode) return enrollFrameServer(face, pose, vw, vh, now);
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
  if (en.step >= en.steps.length) {
    en.auto = false; renderSteps();
    setMsg(`Έτοιμο! ${en.samples.length} λήψεις. Πάτα «Αποθήκευση».`);
    $('enAuto').disabled = false;
    return;
  }
  renderSteps(); setMsg(en.steps[en.step].msg);
}
async function saveEnroll() {
  if (enrollToServer()) return saveEnrollServer();
  const name = $('enName').value.trim();
  if (!name || !en.samples.length) return;
  let p = en.person;
  if (!p) {
    const same = gallery.people.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (same && confirm(`Υπάρχει ήδη «${same.name}». Να προστεθούν οι λήψεις σε αυτό το άτομο;`)) p = same;
  }
  const front = en.samples.find((s) => s.pose && Math.abs(s.pose.yaw) < 12) || en.samples[0];
  if (p) { p.embeddings = [...p.embeddings, ...en.samples.map((s) => s.e)].slice(-40); if (!p.thumb) p.thumb = front.thumb; }
  else {
    p = { id: db.newId(), name, thumb: front.thumb, created: Date.now(), embeddings: en.samples.map((s) => s.e) };
    if (!hasOwnProfile()) p.me = true;   // the first person enrolled on a device without a profile = the owner
  }
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
      const img = new Image(); img.src = thumb; $('enThumbs').appendChild(img);
      en.samples.push({ e, thumb, pose: null, blob: enrollToServer() ? f : null, el: img, label: server.classifyPose(res.faces[i].pose) });
    } catch (err) { console.warn(err); setMsg('Σφάλμα στη φωτογραφία: ' + err.message); }
  }
  $('enSave').disabled = !($('enName').value.trim() && en.samples.length);
  if (en.samples.length) setMsg(`Λήψεις: ${en.samples.length}. Πάτα «Αποθήκευση».`);
}

// ---------- UI wiring ----------
$('btnStart').onclick = () => { goFullscreen(); start(); };

// ---- Full screen / install (hides the browser address bar) ----
const isStandalone = () => window.matchMedia('(display-mode: fullscreen)').matches || window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function goFullscreen() {
  if (isStandalone()) return;
  const el = document.documentElement;
  try { const p = (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el, { navigationUI: 'hide' }); p?.catch?.(() => {}); } catch (_) {}
}
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; if (!isStandalone()) $('btnInstall').classList.remove('hidden'); });
window.addEventListener('appinstalled', () => { deferredInstall = null; $('btnInstall').classList.add('hidden'); });
$('btnInstall').onclick = async () => { if (!deferredInstall) return; deferredInstall.prompt(); try { await deferredInstall.userChoice; } catch (_) {} deferredInstall = null; $('btnInstall').classList.add('hidden'); };
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !isStandalone()) $('iosHint').classList.remove('hidden');

$('btnFlip').onclick = () => openCamera(facing === 'user' ? 'environment' : 'user');
$('btnEnroll').onclick = () => openEnroll();
$('pAddNew').onclick = () => { closePeople(); openEnroll(); };
$('btnPeople').onclick = openPeople;
$('pClose').onclick = closePeople;
$('enCancel').onclick = closeEnroll;
$('enSave').onclick = saveEnroll;
$('enName').oninput = () => { $('enSave').disabled = !($('enName').value.trim() && en.samples.length); };
$('enToSrv').onchange = () => setupEnrollServer(en.person, true);
$('enAuto').onclick = () => {
  en.srvMode = enrollToServer(); en.steps = en.srvMode ? SRV_STEPS : STEPS;
  en.auto = true; en.step = 0; en.stepStart = performance.now(); en.st = {};
  $('enAuto').disabled = true; renderSteps(); setMsg(en.steps[0].msg);
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
initServerUi();
boot();

// ======================================================================
// Family-server mode (optional; everything below is inactive until a server URL is set)
// ======================================================================
function serverOn() { return !!(cfg.enabled && cfg.url && cfg.token); }
const SRV_INTERVAL = 400; // at most 2.5 recognise calls per second
const srv = { inflight: false, last: 0, offline: false, retryAt: 0, calls: 0, ok: 0, lastError: null };

async function serverStep(tracks, vw, vh, now) {
  if (srv.inflight || now - srv.last < SRV_INTERVAL) return;
  if (srv.offline && now < srv.retryAt) return;
  const cand = tracks.filter((t) => t.missed === 0 && t.wpx >= 36 && Math.abs(t.pose.yaw) <= 75 &&
    now - (t.srvAt || 0) > (t.srv ? 1500 : 350)).sort((a, b) => (a.srvAt || 0) - (b.srvAt || 0)).slice(0, 3);
  if (!cand.length) return; // no faces in view -> no network traffic
  srv.last = now;
  const faces = [];
  for (const t of cand) {
    try {
      const e0 = performance.now();
      const e = await embedder.run(embedder.crop(frameCanvas, t.kps, vw, vh));
      const ems = performance.now() - e0;
      stats.emb = ema(stats.emb, ems, 0.2); stats.embN++; stats.embSamples.push(ems); if (stats.embSamples.length > 300) stats.embSamples.shift();
      t.srvAt = now;
      faces.push({ id: t.id, box: [t.box.x0, t.box.y0, t.box.x1, t.box.y1], embedding: Array.from(e, (v) => Math.round(v * 1e5) / 1e5) });
    } catch (err) { console.warn(err); }
  }
  if (!faces.length) return;
  srv.inflight = true; srv.calls++;
  api.recognize(faces).then((r) => {
    if (srv.offline) { srv.offline = false; tracker.relabel(); setStatus('☁️ Συνδέθηκε ξανά με τον server'); }
    srv.ok++; srv.lastError = null;
    for (const f of r.faces) {
      const t = tracker.tracks.find((x) => x.id === f.id);
      if (!t) continue;
      t.embeds++;
      if (f.status === 'known') {
        // 0.4.0: 'display.items' (1-2 of name/message1/message2/object3d) + sizes; 0.3.0: one 'display.mode'; older: 'message'
        const v = viewOf(f.display || { mode: 'message', text: f.message || '' });
        t.srvMiss = 0; t.srv = true; t.label = f.name; t.personId = f.person_id; t.sim = f.similarity;
        t.objectId = v.objectId; t.message = v.text; t.showName = v.showName; t.sizes = v.sizes;
        if (!t.recognisedAt) t.recognisedAt = performance.now();
      } else {
        t.srvMiss = (t.srvMiss || 0) + 1;
        if (t.srv && t.srvMiss >= 2) { t.srv = false; t.label = null; t.message = ''; t.objectId = ''; t.personId = null; t.showName = true; t.sizes = null; }
      }
    }
  }).catch((e) => {
    srv.lastError = e;
    const wasOffline = srv.offline;
    srv.offline = true;
    srv.retryAt = performance.now() + (e.status === 401 ? 15000 : 5000);
    if (!wasOffline) {
      for (const t of tracker.tracks) if (t.srv) { t.srv = false; t.label = null; t.message = ''; t.objectId = ''; t.showName = true; t.sizes = null; }
      tracker.relabel();
      const local = gallery.people.length ? 'συνεχίζω με τα άτομα αυτής της συσκευής' : 'θα ξαναδοκιμάσω σε λίγο';
      setStatus(e.status === 401 ? (adv ? '⚠️ Server: το token δεν ισχύει — δες τις Ρυθμίσεις' : '⚠️ Το προφίλ σου δεν βρέθηκε — δες τις Ρυθμίσεις')
        : `⚠️ Εκτός σύνδεσης — ${local}`);
    }
  }).finally(() => { srv.inflight = false; });
}

// message bubbles above the 3D names (server mode only; local people have no message)
const bubbleEls = new Map();
function renderBubbles() {
  const live = new Set();
  if (mode === 'scan') {
    for (const [id, rec] of labels.meshes) {
      if (!rec.msg || rec.sx === undefined) continue;
      live.add(id);
      let el = bubbleEls.get(id);
      if (!el) { el = document.createElement('div'); el.className = 'bubble'; $('bubbles').appendChild(el); bubbleEls.set(id, el); }
      if (el.textContent !== rec.msg) el.textContent = rec.msg;
      const fs = Math.round(16 * (rec.textScale || 1)) + 'px';   // the person's «μέγεθος σχολίου»
      if (el.style.fontSize !== fs) el.style.fontSize = fs;
      const top = rec.top ?? rec.sy - rec.ss * 1.2;      // above the name / 3D object stack
      const below = top - el.offsetHeight < 64;          // no room under the top bar -> put it under the name
      el.style.transform = below ? `translate(${rec.sx}px, ${rec.low ?? rec.sy + 6}px) translate(-50%, 0)` : `translate(${rec.sx}px, ${top}px) translate(-50%, -100%)`;
    }
  }
  for (const [id, el] of bubbleEls) if (!live.has(id)) { el.remove(); bubbleEls.delete(id); }
}

// ---------- server enrollment ----------
const SRV_STEPS = [
  { msg: 'Κοίτα ευθεία στην κάμερα', ok: (p) => Math.abs(p.yaw) < 10 && p.pitch > -9 && p.pitch < 12 },
  { msg: 'Γύρνα αργά το κεφάλι προς τη μία πλευρά', ok: (p) => ['left', 'right'].includes(server.classifyPose(p)) && Math.abs(p.yaw) > 18, sign: 'yaw' },
  { msg: 'Τώρα προς την άλλη πλευρά', ok: (p, st) => ['left', 'right'].includes(server.classifyPose(p)) && Math.abs(p.yaw) > 18 && Math.sign(p.yaw) !== st.yawSign },
  { msg: 'Σήκωσε το πηγούνι (κοίτα λίγο προς τα πάνω)', ok: (p) => server.classifyPose(p) === 'up' },
  { msg: 'Κατέβασε το πηγούνι (κοίτα λίγο προς τα κάτω)', ok: (p) => server.classifyPose(p) === 'down' },
  { msg: 'Προαιρετικά: γύρνα εντελώς στο πλάι (προφίλ)', ok: (p) => server.classifyPose(p).startsWith('profile'), sign: 'yaw2', optional: true },
  { msg: 'Προαιρετικά: προφίλ και από την άλλη πλευρά', ok: (p, st) => server.classifyPose(p).startsWith('profile') && Math.sign(p.yaw) !== st.yaw2Sign, optional: true },
];
const SRV_WAIT = 10000, SRV_WAIT_OPTIONAL = 6000, SRV_GAP = 600;

// Open enrollment: when the server says so, anyone with the address can create their profile without the family key.
let srvOpen = null; // null = unknown, true/false = as reported by /health
let srvReach = null; // null = unknown, true/false = did the last /health answer
function applyOpenEnrollment() {
  $('enFamKey').classList.toggle('hidden', srvOpen === true);
}
async function checkOpenEnrollment() {
  if (!cfg.url) return srvOpen;
  try { srvOpen = !!noteHealth(await api.health(4000)).open_enrollment; srvReach = true; } catch { srvReach = false; /* keep last known */ }
  applyOpenEnrollment();
  return srvOpen;
}

function enrollToServer() { return !!cfg.url && !$('enSrv').classList.contains('hidden') && $('enToSrv').checked; }

function setupEnrollServer(existing, keepCheck = false) {
  const can = !!cfg.url && !existing;
  $('enSrv').classList.toggle('hidden', !can);
  if (!can) { $('enName').disabled = !!existing; return; }
  if (!keepCheck) $('enToSrv').checked = true;
  const on = $('enToSrv').checked, registered = !!cfg.token;
  $('enSrvFields').classList.toggle('hidden', !on || registered);
  if (on && registered) {
    $('enName').value = cfg.name || ''; $('enName').disabled = true;
    setMsg(`Πρόσθεσε λήψεις στο προφίλ σου στον server${cfg.name ? ` («${cfg.name}»)` : ''}. Πάτα ▶.`);
  } else {
    $('enName').disabled = false;
    if (on) {
      const hint = () => setMsg(srvOpen === true ? 'Γράψε το όνομά σου και πάτα ▶ Αυτόματη λήψη.'
        : 'Γράψε το όνομά σου, το κλειδί της οικογένειας και πάτα ▶ Αυτόματη λήψη.');
      applyOpenEnrollment(); hint();
      const shown = $('enMsg').textContent;
      checkOpenEnrollment().then(() => {
        if (mode !== 'enroll' || existing !== en.person) return;
        if (srvReach === false && !en.auto && !en.samples.length) {
          // Server unreachable: fall back to on-device enrollment (the user can tick ☁️ again to retry).
          $('enToSrv').checked = false; $('enSrvFields').classList.add('hidden');
          setMsg('Ο server της οικογένειας δεν απαντά τώρα — η καταχώριση θα γίνει μόνο σε αυτή τη συσκευή. Βάλε όνομα και πάτα ▶ (ή τσέκαρε ξανά το ☁️ για να ξαναδοκιμάσεις).');
        } else if ($('enMsg').textContent === shown) hint();
      });
    }
  }
}

async function enrollFrameServer(face, pose, vw, vh, now) {
  const step = en.steps[en.step];
  const taken = en.samples.filter((s) => s.step === en.step).length;
  const wait = now - en.stepStart;
  if (pose && step.ok(pose, en.st) && now - en.lastCap > SRV_GAP) {
    en.lastCap = now;
    if (step.sign === 'yaw') en.st.yawSign = Math.sign(pose.yaw);
    if (step.sign === 'yaw2') en.st.yaw2Sign = Math.sign(pose.yaw);
    await capture(face, vw, vh, pose);
    en.samples[en.samples.length - 1].step = en.step;
    if (taken + 1 >= PER_STEP) nextStep();
  } else if ((taken > 0 && wait > STEP_TIMEOUT) || wait > (step.optional ? SRV_WAIT_OPTIONAL : SRV_WAIT)) {
    nextStep(); // skip: the server will tell us what is still missing
  }
}

// JPEG of the area around the face (not the whole room), full camera resolution
let jpegCanvas = null;
async function frameJpeg(face, vw, vh) {
  const w = face.x1 - face.x0, h = face.y1 - face.y0, cx = (face.x0 + face.x1) / 2, cy = (face.y0 + face.y1) / 2;
  const half = Math.max(w, h) * 1.1;
  const x0 = Math.max(0, Math.round(cx - half)), y0 = Math.max(0, Math.round(cy - half * 1.1));
  const x1 = Math.min(vw, Math.round(cx + half)), y1 = Math.min(vh, Math.round(cy + half));
  const cw = Math.max(2, x1 - x0), ch = Math.max(2, y1 - y0);
  if (!jpegCanvas) jpegCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(cw, ch) : document.createElement('canvas');
  jpegCanvas.width = cw; jpegCanvas.height = ch;
  jpegCanvas.getContext('2d').drawImage(frameCanvas, x0, y0, cw, ch, 0, 0, cw, ch);
  if (jpegCanvas.convertToBlob) return jpegCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return new Promise((r) => jpegCanvas.toBlob(r, 'image/jpeg', 0.92));
}

async function saveEnrollServer() {
  const send = en.samples.filter((s) => s.blob && !s.sent);
  if (!send.length) { setMsg('Δεν υπάρχουν νέες λήψεις για αποστολή.'); return; }
  $('enSave').disabled = true; $('enAuto').disabled = true;
  const result = { ok: 0, rejected: {}, enrollment: null };
  try {
    if (!cfg.token) {
      const name = $('enName').value.trim(), key = $('enFamKey').value.trim();
      if (!name) { setMsg('Γράψε το όνομά σου.'); return; }
      if (!key && srvOpen !== true) await checkOpenEnrollment();
      if (!key && srvOpen !== true) { applyOpenEnrollment(); setMsg('Χρειάζεται το κλειδί της οικογένειας (στο ζητάει μόνο αυτή τη φορά).'); return; }
      setMsg('Δημιουργία του προφίλ σου στον server…');
      let r;
      try {
        r = await api.createPerson(key || null, name, $('enSrvMsg').value.trim(), $('enSrvFamily').checked ? 'family' : 'selected');
      } catch (e) {
        if (e.status === 401 && e.code === 'family_key_required') { srvOpen = false; applyOpenEnrollment(); }
        throw e;
      }
      cfg.token = r.token; cfg.personId = r.person.id; cfg.name = r.person.name; server.saveCfg(cfg);
      $('enFamKey').value = '';
      if (adv) showToken(r.token);   // normal users: the token stays on this phone, no technical screen
      syncServerUi();
    }
    if (!cfg.personId) { const me = await api.me(); cfg.personId = me.id; cfg.name = me.name; server.saveCfg(cfg); }
    let i = 0;
    for (const s of send) {
      setMsg(`Αποστολή λήψης ${++i}/${send.length}…`);
      try {
        const r = await api.addFrame(cfg.personId, s.label, s.blob);
        s.sent = true; s.el.classList.add('ok'); result.ok++; result.enrollment = r.enrollment;
      } catch (e) {
        if (e.status === 0 || e.status === 401) throw e;
        s.sent = true; s.el.classList.add('bad'); s.el.title = server.errEl(e);
        const why = server.errEl(e); result.rejected[why] = (result.rejected[why] || 0) + 1;
        if (e.detail && e.detail.enrollment) result.enrollment = e.detail.enrollment;
      }
    }
    window.__ar.lastServerEnroll = result;
    refreshFamily();
    const enr = result.enrollment;
    const rej = Object.entries(result.rejected).map(([w, n]) => `${n}× ${w}`).join('· ');
    const head = `Στάλθηκαν ${result.ok} λήψεις${rej ? `, απορρίφθηκαν: ${rej}` : ''}.`;
    if (enr && enr.active) {
      cfg.enabled = true; server.saveCfg(cfg); syncServerUi(); tracker.relabel();
      setMsg(`${head} ✅ Το προφίλ σου είναι έτοιμο (${enr.frames} λήψεις). Η αναγνώριση μέσω server ενεργοποιήθηκε.`);
      setTimeout(() => { if (mode === 'enroll' && $('tokSheet').classList.contains('hidden')) closeEnroll(); }, 3500);
    } else {
      const miss = enr ? enr.missing_poses : [];
      const need = enr ? enr.frames_still_needed : 0;
      setMsg(`${head} Χρειάζονται ακόμα ${need} λήψεις${miss.length ? ` — λείπουν: ${server.posesEl(miss)}` : ''}. Πάτα ξανά ▶ Αυτόματη λήψη ή 📸.`);
    }
  } catch (e) {
    setMsg('⚠️ ' + (e.code === 'offline' || e.code === 'timeout'
      ? (adv ? 'Ο server δεν απαντά. Έλεγξε τη διεύθυνση στις Ρυθμίσεις και ξαναπάτα «Αποθήκευση».' : 'Εκτός σύνδεσης. Δοκίμασε ξανά «Αποθήκευση» σε λίγο.')
      : 'Σφάλμα: ' + errMsg(e)));
  } finally {
    $('enAuto').disabled = false;
    $('enSave').disabled = !en.samples.some((s) => s.blob && !s.sent);
  }
}

function showToken(tok) {
  $('tokVal').value = tok; $('tokCopied').textContent = '';
  $('tokSheet').classList.remove('hidden');
}
$('tokCopy').onclick = async () => {
  try { await navigator.clipboard.writeText($('tokVal').value); $('tokCopied').textContent = 'Αντιγράφηκε ✓'; }
  catch (e) { $('tokVal').select(); document.execCommand && document.execCommand('copy'); $('tokCopied').textContent = 'Επιλέχθηκε — πάτα «Αντιγραφή» από το μενού.'; }
};
$('tokOk').onclick = () => { $('tokVal').value = ''; $('tokSheet').classList.add('hidden'); };

// ---------- server settings + permissions ----------
function syncServerUi() {
  $('srvUrl').value = cfg.url || '';
  $('srvUrlNote').textContent = !cfg.url ? 'Χωρίς server: όλα γίνονται μόνο σε αυτή τη συσκευή.'
    : server.isDefaultUrl(cfg) ? 'Ο server της οικογένειας (προεπιλογή). Άδειασε το πεδίο για χρήση μόνο στη συσκευή.'
      : 'Δική σου διεύθυνση. Άδειο = μόνο στη συσκευή.';
  $('srvDefault').classList.toggle('hidden', server.isDefaultUrl(cfg));
  $('srvToken').value = cfg.token || '';
  $('srvOn').checked = !!cfg.enabled;
  $('srvOn').disabled = !(cfg.url && cfg.token);
  syncEnrollBtn();
  $('privacyNote').textContent = serverOn()
    ? 'Λειτουργία server: για την αναγνώριση στέλνεται στον server της οικογένειας μόνο ένα αριθμητικό αποτύπωμα κάθε προσώπου (όχι εικόνα).'
    : 'Όλα γίνονται μόνο σε αυτή τη συσκευή. Καμία εικόνα δεν φεύγει από το κινητό.';
}
function initServerUi() {
  syncServerUi();
  $('srvUrl').onchange = () => {
    server.setUserUrl(cfg, $('srvUrl').value); srvOpen = null; srvReach = null; srv.offline = false;
    server.saveCfg(cfg); syncServerUi(); fam.people = null; fam.count = null; refreshFamily();
    if (!cfg.url) $('srvInfo').textContent = 'Ο server απενεργοποιήθηκε — όλα γίνονται μόνο σε αυτή τη συσκευή.';
  };
  $('srvDefault').onclick = () => {
    server.resetUrl(cfg); srvOpen = null; srvReach = null; srv.offline = false;
    server.saveCfg(cfg); syncServerUi(); refreshServer(true); refreshFamily();
  };
  $('srvToken').onchange = () => { cfg.token = $('srvToken').value.trim(); cfg.personId = null; cfg.name = ''; server.saveCfg(cfg); syncServerUi(); refreshFamily(); };
  $('srvTest').onclick = () => refreshServer(true);
  $('srvOn').onchange = () => {
    cfg.enabled = $('srvOn').checked; server.saveCfg(cfg); srv.offline = false;
    for (const t of tracker.tracks) { t.srv = false; t.message = ''; t.objectId = ''; t.showName = true; t.sizes = null; }
    tracker.relabel(); syncServerUi(); reloadPeople();
    setStatus(cfg.enabled ? '☁️ Αναγνώριση μέσω server' : 'Αναγνώριση στη συσκευή');
  };
  $('srvLogout').onclick = () => {
    if (cfg.token && !confirm('Αποσύνδεση από τον server; Θα χρειαστείς το token σου για να ξανασυνδεθείς.')) return;
    Object.assign(cfg, { token: '', personId: null, name: '', enabled: false }); server.saveCfg(cfg);
    syncServerUi(); $('srvMe').classList.add('hidden'); $('srvInfo').textContent = 'Αποσυνδέθηκες.'; tracker.relabel(); refreshFamily();
  };
  $('srvMsgSave').onclick = async () => {
    const f = { message: $('srvMsg').value.trim() };
    let note = '';
    if (hasCap('display')) {
      const items = selItems();
      Object.assign(f, { message2: $('srvMsg2').value.trim(), object_id: dispObj });
      if (hasCap('combo')) f.display_items = items;
      else f.display_mode = ({ message1: 'message', message2: 'message2', object3d: 'object3d' })[items[0]] || 'message';
      if (hasCap('sizes')) Object.assign(f, { size_name: +$('szName').value, size_text: +$('szText').value, size_object: +$('szObj').value });
      const empty = [['message1', f.message, 'το Μήνυμα 1'], ['message2', f.message2, 'το Μήνυμα 2']].filter(([k, t]) => items.includes(k) && !t).map((x) => x[2]);
      if (empty.length) note = ` (${empty.join(' και ')} είναι κενό — δεν θα φαίνεται)`;
    }
    try { await api.patchMe(cfg.personId, f); dispDirty = false; $('srvInfo').textContent = (hasCap('display') ? 'Αποθηκεύτηκε ✓' : 'Το μήνυμα αποθηκεύτηκε ✓') + note; }
    catch (e) { $('srvInfo').textContent = '⚠️ ' + errMsg(e); }
  };
  // object picker (from the registry in objects3d.js)
  for (const o of OBJECTS) {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.obj = o.id; b.title = o.name;
    if (o.thumb) { const im = new Image(); im.loading = 'lazy'; im.decoding = 'async'; im.alt = ''; im.width = im.height = 48; im.src = assetUrl(o.thumb); b.appendChild(im); }
    else { const e = document.createElement('span'); e.className = 'emo'; e.textContent = o.emoji; b.appendChild(e); }
    const t = document.createElement('span'); t.textContent = o.name; b.appendChild(t);
    b.onclick = () => { pickObject(o.id); dispDirty = true; autoPick('object3d'); };
    $('objPick').appendChild(b);
  }
  for (const b of itemBoxes()) b.onchange = () => { dispDirty = true; syncItems(b); if (b.value === 'object3d' && b.checked) pickObject(dispObj); };
  $('srvMsg').oninput = () => { autoPick('message1'); updatePreview(); };
  $('srvMsg2').oninput = () => { autoPick('message2'); updatePreview(); };
  for (const id of ['szName', 'szText', 'szObj']) $(id).oninput = () => { dispDirty = true; showSize(id); updatePreview(); };
  $('srvFamily').onchange = async () => {
    try { await api.patchMe(cfg.personId, { visibility: $('srvFamily').checked ? 'family' : 'selected' }); await refreshServer(); }
    catch (e) { $('srvInfo').textContent = '⚠️ ' + errMsg(e); $('srvFamily').checked = !$('srvFamily').checked; }
  };
  $('srvDelMe').onclick = async () => {
    if (!confirm('Διαγραφή του προφίλ σου από τον server; Σβήνονται οι φωτογραφίες, το μήνυμα και οι άδειες. Δεν αναιρείται.')) return;
    try {
      await api.deletePerson(cfg.personId);
      Object.assign(cfg, { token: '', personId: null, name: '', enabled: false }); server.saveCfg(cfg);
      syncServerUi(); $('srvMe').classList.add('hidden'); $('srvInfo').textContent = 'Το προφίλ σου διαγράφηκε από τον server.'; refreshFamily();
    } catch (e) { $('srvInfo').textContent = '⚠️ ' + errMsg(e); }
  };
  const btnPeople = $('btnPeople').onclick;
  $('btnPeople').onclick = () => { btnPeople(); refreshServer(); };
}

let dispObj = DEFAULT_OBJECT;
function pickObject(id) {
  dispObj = objectInfo(id).id;
  for (const b of $('objPick').children) b.classList.toggle('sel', b.dataset.obj === dispObj);
  try { previewObject($('objPrev'), dispObj); } catch (e) { console.warn('preview', e); }
  updatePreview();
}

// «Τι βλέπουν οι άλλοι»: 0.4.0 = 1-2 of name/message1/message2/object3d (+ sizes);
// 0.3.0 = the name always + exactly one of the other three; 0.2.0 = message only.
function itemBoxes() { return [...document.querySelectorAll('.dispItem')]; }
function activeBoxes() { return itemBoxes().filter((b) => dispMulti || b.value !== 'name'); }
const selItems = () => activeBoxes().filter((b) => b.checked).map((b) => b.value);
function syncItems(changed = null) {
  const boxes = activeBoxes();
  let warn = '';
  if (!dispMulti) {
    if (changed && changed.checked) for (const b of boxes) if (b !== changed) b.checked = false;
    if (!boxes.some((b) => b.checked)) { (changed || boxes[0]).checked = true; if (changed) warn = ' Χρειάζεται μία επιλογή.'; }
    for (const b of boxes) b.disabled = false;
  } else {
    if (changed && changed.checked && boxes.filter((b) => b.checked).length > 2) { changed.checked = false; warn = ' Το πολύ 2 — ξετσέκαρε πρώτα ένα.'; }
    if (!boxes.some((b) => b.checked)) { (changed || boxes[0]).checked = true; warn = ' Χρειάζεται τουλάχιστον ένα.'; }
    const n = boxes.filter((b) => b.checked).length;
    for (const b of boxes) b.disabled = !b.checked && n >= 2;
  }
  const n = selItems().length;
  $('dispHint').textContent = dispMulti
    ? `Διάλεξε 1 ή 2 (π.χ. όνομα + 3D αντικείμενο ή σχόλιο + 3D αντικείμενο). Επιλεγμένα: ${n}/2.${warn}`
    : `Διάλεξε ένα από τα τρία. Όσοι σε αναγνωρίζουν βλέπουν το όνομά σου και μόνο αυτό που διάλεξες.${warn}`;
  updatePreview();
}
function autoPick(item) {   // typing a message / tapping an object ticks it, if there is room
  const b = activeBoxes().find((x) => x.value === item);
  if (!b || b.checked || (dispMulti && selItems().length >= 2)) return;
  b.checked = true; dispDirty = true; syncItems(b);
}
function setItems(items) { for (const b of itemBoxes()) b.checked = items.includes(b.value); syncItems(); }
function showSize(id) { const el = $(id); el.nextElementSibling.textContent = '×' + (+el.value).toFixed(1); }
function setSizes(sz = {}) {
  for (const [id, k] of [['szName', 'name'], ['szText', 'text'], ['szObj', 'object']]) { $(id).value = Math.min(2, Math.max(0.5, +sz[k] || 1)); showSize(id); }
}
function updatePreview() {   // tiny HTML mock of the label (no WebGL), only on 0.4.0 servers
  if (!hasCap('sizes')) return;
  const items = selItems(), pv = $('dispPrev');
  const name = pv.querySelector('.pv-name'), bub = pv.querySelector('.pv-bub'), obj = pv.querySelector('.pv-obj');
  name.hidden = !items.includes('name'); name.textContent = cfg.name || 'Όνομα';
  name.style.fontSize = (20 * +$('szName').value).toFixed(0) + 'px';
  const texts = [['message1', 'srvMsg'], ['message2', 'srvMsg2']].filter(([k]) => items.includes(k)).map(([, id]) => $(id).value.trim()).filter(Boolean);
  bub.hidden = !texts.length; bub.textContent = texts.join('\n');
  bub.style.fontSize = (13 * +$('szText').value).toFixed(1) + 'px';
  const o = objectInfo(dispObj), px = Math.round(38 * +$('szObj').value);
  obj.hidden = !items.includes('object3d');
  if (!obj.hidden) {
    const key = o.id + ':' + px;
    if (obj.dataset.key !== key) {
      obj.dataset.key = key; obj.textContent = '';
      if (o.thumb) { const im = new Image(); im.alt = ''; im.width = im.height = px; im.src = assetUrl(o.thumb); obj.appendChild(im); }
      else { obj.textContent = o.emoji; obj.style.fontSize = Math.round(px * 0.8) + 'px'; }
    }
  }
}

async function refreshServer(verbose = false) {
  const info = $('srvInfo'), advInfo = $('srvAdvInfo');
  advInfo.textContent = '';
  if (!cfg.url) {
    info.textContent = '☁️ Εκτός σύνδεσης — όλα γίνονται μόνο σε αυτή τη συσκευή.';
    if (adv) advInfo.textContent = 'Χωρίς server. (Για server, γράψε διεύθυνση ή πάτα «Προεπιλεγμένος server».)';
    return;
  }
  if (verbose) info.textContent = 'Έλεγχος…';
  try {
    const h = noteHealth(await api.health());
    srvOpen = !!h.open_enrollment; applyOpenEnrollment();
    if (adv) advInfo.textContent = `Ο server απαντά ✓ · έκδοση ${h.version || '?'} · ${h.people} άτομα` + (hasCap('display') ? '' : ' · παλιά έκδοση (χωρίς «Μήνυμα 2» / 3D αντικείμενα / online)');
    if (!cfg.token) {
      $('srvMe').classList.add('hidden');
      info.textContent = '☁️ Συνδεδεμένος ✓ — δεν έχεις ακόμα προφίλ. Πάτα «＋ Νέο άτομο» και καταχώρισε τον εαυτό σου'
        + (srvOpen ? '' : ' (θα χρειαστείς το κλειδί της οικογένειας)') + (adv ? ', ή βάλε το token σου.' : '.');
      return;
    }
    const me = await api.me();
    cfg.personId = me.id; cfg.name = me.name; server.saveCfg(cfg);
    const { people } = await api.people();
    const e = me.enrollment;
    info.textContent = `☁️ Συνδεδεμένος ✓ ως «${me.name}» — ` + (e.active ? 'το προφίλ σου είναι έτοιμο.'
      : `λείπουν λήψεις: ${server.posesEl(e.missing_poses) || e.frames_still_needed}. Πάτα «＋ Νέο άτομο» για να τις προσθέσεις.`);
    if (adv) advInfo.textContent += ` · προφίλ #${me.id}, ${e.frames} λήψεις`;
    $('srvMe').classList.remove('hidden');
    // «Τι βλέπουν οι άλλοι»: 0.4.0 two items + sizes; 0.3.0 one item; older servers: the one message only
    const disp = hasCap('display');
    dispMulti = disp && hasCap('combo');
    for (const el of document.querySelectorAll('#srvMe .disp-only')) el.classList.toggle('hidden', !disp);
    for (const el of document.querySelectorAll('#srvMe .combo-only')) el.classList.toggle('hidden', !dispMulti);
    for (const el of document.querySelectorAll('#srvMe .sizes-only')) el.classList.toggle('hidden', !(disp && hasCap('sizes')));
    $('srvDispOld').classList.toggle('hidden', dispMulti);
    $('srvDispOld').textContent = disp ? '⚠️ Χρειάζεται ενημέρωση server (0.4.0) για 2 επιλογές μαζί και μεγέθη — τώρα φαίνεται το όνομα + μία επιλογή.'
      : '⚠️ Χρειάζεται ενημέρωση server (0.4.0) για «Μήνυμα 2», 3D αντικείμενα και μεγέθη — τώρα φαίνεται μόνο το μήνυμα.';
    $('dispTitle').textContent = disp ? 'Τι βλέπουν οι άλλοι πάνω από το κεφάλι μου' : 'Το μήνυμά μου (φαίνεται πάνω από το όνομά μου)';
    const editing = [$('srvMsg'), $('srvMsg2')].includes(document.activeElement);
    if (!editing && !dispDirty) {
      $('srvMsg').value = me.message || '';
      $('srvMsg2').value = me.message2 || '';
      if (disp) {
        setItems(Array.isArray(me.display_items) && dispMulti ? me.display_items : ['name', ITEM_OF_MODE[me.display_mode] || 'message1']);
        setSizes(me.sizes);
        pickObject(me.object_id || DEFAULT_OBJECT);
      }
    }
    const fam = me.visibility === 'family';
    $('srvFamily').checked = fam;
    const allowed = new Set(me.allowed_viewers.map((v) => (typeof v === 'object' ? v.id : v)));
    const ul = $('srvMembers'); ul.innerHTML = '';
    // normal users: only people online now + those you already allowed (no full member list)
    const others = people.filter((p) => p.id !== me.id && (adv || p.online === true || allowed.has(p.id)));
    $('srvMembersNote').textContent = adv ? 'Όποιος δεν έχει άδεια σε βλέπει σαν άγνωστο πρόσωπο.'
      : 'Φαίνονται όσοι είναι online τώρα και όσοι έχουν ήδη άδεια. Όποιος δεν έχει άδεια σε βλέπει σαν άγνωστο πρόσωπο.';
    if (!others.length) ul.innerHTML = `<li class="small">${adv ? 'Δεν υπάρχουν ακόμα άλλα μέλη.' : 'Δεν είναι κανείς άλλος online τώρα.'}</li>`;
    for (const p of others) {
      const li = document.createElement('li');
      li.innerHTML = '<label class="setting check"><input type="checkbox"> <span></span></label>';
      const cb = li.querySelector('input');
      li.querySelector('span').textContent = p.name + (p.online ? ' 🟢' : '') + (adv && !p.active ? ' (δεν έχει ολοκληρώσει την καταχώριση)' : '');
      cb.checked = fam || allowed.has(p.id); cb.disabled = fam; cb.dataset.id = p.id;
      cb.onchange = async () => {
        try { cb.checked ? await api.grant(me.id, p.id) : await api.revoke(me.id, p.id); info.textContent = 'Οι άδειες αποθηκεύτηκαν ✓'; }
        catch (err) { cb.checked = !cb.checked; info.textContent = '⚠️ ' + errMsg(err); }
      };
      ul.appendChild(li);
    }
    syncServerUi();
  } catch (e) {
    $('srvMe').classList.add('hidden');
    if (e.status === 401) info.textContent = adv ? '⚠️ ' + server.errEl(e) : '⚠️ Το προφίλ σου δεν βρέθηκε στον server (ίσως διαγράφηκε). Πάτα «＋ Νέο άτομο» για να καταχωριστείς ξανά.';
    else info.textContent = '☁️ Εκτός σύνδεσης — θα ξαναδοκιμάσω όταν ανοίξεις πάλι τις ρυθμίσεις.';
    if (adv) advInfo.textContent = '⚠️ ' + server.errEl(e) + (e.code === 'offline' ? ' — έλεγξε τη διεύθυνση.' : '');
  }
}
