import { Detector } from './detector.js';
import { Embedder } from './embedder.js';
import { Labels3D } from './labels3d.js';
import { Gallery, Tracker } from './tracker.js';
import * as db from './db.js';
import * as server from './server.js';
import { ChimeRounds, unlockAudio, chimeStats, playShutter } from './chime.js';
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
const chimes = new ChimeRounds();
let facing = 'environment', stream = null, mode = 'scan', ready = false;
const cfg = server.loadCfg();
const api = new server.Api(cfg);
window.__ar = { cfg, api, get srv() { return srv; }, srvOrder: (...a) => srvOrder(...a), renderWhy: (...a) => renderWhy(...a), get srvLimits() { return { batch: SRV_BATCH, max: SRV_MAX_FACES }; }, get caps() { return caps; }, get adv() { return adv; }, tracker, detector, embedder, labels, stats, settings, gallery, chimes, chime: chimeStats, get mode() { return mode; }, get fam() { return fam; }, get ready() { return ready; }, db, openEnroll: (...a) => openEnroll(...a) };

function setStatus(t) { $('status').textContent = t; }

// ---------- v23: saved messages history (on this device only) ----------
// Every message saved with «Αποθήκευση» is remembered (deduped, most recent first, max 30). Under each message
// field: «🕘 Αποθηκευμένα (n)» opens the list; tap a message to put it in the field, «🗑️» removes it.
const MSG_HIST_KEY = 'ar-names-msg-history', MSG_HIST_MAX = 30;
function msgHistLoad() {
  try { const a = JSON.parse(localStorage.getItem(MSG_HIST_KEY) || '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()) : []; }
  catch (_) { return []; }
}
function msgHistSave(a) { try { localStorage.setItem(MSG_HIST_KEY, JSON.stringify(a.slice(0, MSG_HIST_MAX))); } catch (_) {} }
const msgKey = (t) => t.trim().replace(/\s+/g, ' ').toLocaleLowerCase('el');
function msgHistAdd(...texts) {   // later arguments end up first
  let a = msgHistLoad();
  for (const raw of texts) {
    const t = (raw || '').trim(); if (!t) continue;
    a = [t, ...a.filter((x) => msgKey(x) !== msgKey(t))];
  }
  msgHistSave(a); renderMsgHist();
}
function msgHistDel(t) { msgHistSave(msgHistLoad().filter((x) => x !== t)); renderMsgHist(); }
const msgHistOpen = new Set();
function renderMsgHist() {
  const list = msgHistLoad();
  for (const box of document.querySelectorAll('.msg-hist')) {
    const field = $(box.dataset.for), open = msgHistOpen.has(box.dataset.for) && list.length > 0;
    box.classList.toggle('hidden', !list.length);
    box.replaceChildren();
    if (!list.length) continue;
    const tg = document.createElement('button'); tg.type = 'button'; tg.className = 'mh-toggle';
    tg.textContent = `🕘 Αποθηκευμένα μηνύματα (${list.length}) ${open ? '▴' : '▾'}`;
    tg.setAttribute('aria-expanded', String(open));
    tg.onclick = () => { open ? msgHistOpen.delete(box.dataset.for) : msgHistOpen.add(box.dataset.for); renderMsgHist(); };
    box.appendChild(tg);
    if (!open) continue;
    const ul = document.createElement('ul'); ul.className = 'mh-list';
    for (const t of list) {
      const li = document.createElement('li');
      const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'mh-pick'; pick.textContent = t; pick.title = 'Χρήση αυτού του μηνύματος';
      pick.onclick = () => {
        field.value = t; dispDirty = true;
        field.dispatchEvent(new Event('input', { bubbles: true }));   // same as typing: ticks the item, updates the preview
        msgHistOpen.delete(box.dataset.for); renderMsgHist();
      };
      const del = document.createElement('button'); del.type = 'button'; del.className = 'mh-del'; del.textContent = '🗑️';
      del.setAttribute('aria-label', 'Διαγραφή αποθηκευμένου μηνύματος'); del.title = 'Διαγραφή';
      del.onclick = () => msgHistDel(t);
      li.append(pick, del); ul.appendChild(li);
    }
    box.appendChild(ul);
  }
}
window.__ar.msgHist = { load: msgHistLoad, add: msgHistAdd, del: msgHistDel, render: renderMsgHist };

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
// v23: if the camera permission is already granted (2nd start onwards), the camera opens by itself — no tap on
// «Άνοιγμα κάμερας». Permissions API where it knows 'camera' (Chrome/Android, Safari 16+); elsewhere we remember in
// localStorage that the camera started successfully once and try. Any failure -> the normal button.
const CAM_OK_KEY = 'ar-names-cam-ok';
async function cameraAlreadyAllowed() {
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const st = (await navigator.permissions.query({ name: 'camera' })).state;
      window.__ar.camPerm = st;
      if (st !== 'granted') { if (st === 'denied') localStorage.removeItem(CAM_OK_KEY); return false; }
      return true;
    }
  } catch (_) { /* 'camera' not a known permission name here -> fallback */ }
  window.__ar.camPerm = 'unknown';
  return localStorage.getItem(CAM_OK_KEY) === '1';
}
const camAllowedP = (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) ? cameraAlreadyAllowed() : Promise.resolve(false);
function showStartButton(err) {
  $('start').classList.remove('hidden');
  $('btnStart').disabled = false; $('btnStart').textContent = '📷 Άνοιγμα κάμερας';
  if (err) $('loadErr').textContent = err;
}
// the chime's AudioContext still needs a user gesture: unlock it on the first touch/click after an auto-start
function unlockAudioOnFirstTouch() {
  const evs = ['pointerdown', 'touchstart', 'click', 'keydown'];
  const h = () => { unlockAudio(); evs.forEach((e) => document.removeEventListener(e, h, true)); };
  evs.forEach((e) => document.addEventListener(e, h, { capture: true, passive: true }));
}

async function boot() {
  try {
    setStatus('Φόρτωση μοντέλων…');
    camAllowedP.then((ok) => { if (ok && !ready) $('btnStart').textContent = 'Φόρτωση μοντέλων… η κάμερα θα ανοίξει αυτόματα'; });
    const t0 = performance.now();
    await Promise.all([detector.init(settings.maxFaces), embedder.init(), labels.init(new URL('../fonts/dejavu_sans_bold_greek.typeface.json', import.meta.url).href)]);
    stats.loadMs = Math.round(performance.now() - t0);
    stats.delegate = detector.delegate;
    await reloadPeople();
    refreshFamily();
    setStatus('Έτοιμο');
    const auto = new URLSearchParams(location.search).has('autostart') || await camAllowedP;
    if (auto && !camStarting && !ready) {
      window.__ar.autoStarted = true;
      $('btnStart').disabled = true; $('btnStart').textContent = 'Άνοιγμα κάμερας…';
      unlockAudioOnFirstTouch();
      start({ auto: true });
    } else if (!camStarting && !ready) showStartButton();
  } catch (e) {
    console.error(e);
    $('loadErr').textContent = 'Σφάλμα φόρτωσης: ' + (e && e.message || e);
  }
}

let camStarting = false;
async function start(opts = {}) {
  if (camStarting || ready) return;   // never start twice (auto-start + tap)
  camStarting = true;
  $('btnStart').disabled = true;
  if (!opts.auto) $('start').classList.add('hidden');
  try {
    await openCamera(facing);
  } catch (e) {
    console.warn('camera start failed', e);
    camStarting = false;
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) localStorage.removeItem(CAM_OK_KEY);
    showStartButton(opts.auto ? '' : 'Η κάμερα δεν άνοιξε: ' + (e && (e.message || e.name) || e));
    window.__ar.camError = String(e && (e.name || e.message) || e);
    return;
  }
  localStorage.setItem(CAM_OK_KEY, '1');
  $('loadErr').textContent = '';
  $('start').classList.add('hidden');
  stats.camStart = performance.now();
  ready = true;
  camStarting = false;
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
    // «Ήχος αναγνώρισης»: one soft chime when someone new is recognised (not for '?' faces)
    chimes.update(tracks.filter((x) => x.label && x.missed <= 3).map((x) => (x.personId ? 'p' + x.personId : 'l' + x.label)), now, settings.sound !== false);
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
  renderBubbles(); renderWhy(mode === 'scan' ? tracks : [], vw, vh);
  syncShot();
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
      catch (e) {
        if (e.status !== 401 && !isDeadToken(e)) throw e;
        if (isDeadToken(e) && forgetServerProfile()) setStatus('⚠️ Το προφίλ σου δεν βρέθηκε στον server (ίσως διαγράφηκε). Πάτα «＋ Νέο άτομο» για να καταχωριστείς ξανά.');
        await famFromPublic();
      }   // token no longer valid
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
    t = `Στο δίκτυο: ${plural(fam.count)}` + (fam.mode !== 'count' && onlyHere > 0 ? ` · ${plural(onlyHere)} μόνο σε αυτή τη συσκευή` : '');
    if (fam.mode === 'count' && fam.count > 0) t += '. Για να δεις ποιοι είναι, συνδέσου: καταχώρισε τον εαυτό σου («＋ Νέο άτομο») ή βάλε το token σου στις ρυθμίσεις.';
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
    sizes: d.sizes ? { name: +sz.name || 1, text: +sz.text || 1, object: +sz.object || 1 } : null,
    style: d.style || 'bold' };   // 0.5.0 text style (older servers: the bold look)
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
  $('people').classList.remove('hidden'); syncShot();
  refreshFamily(); clearInterval(fam.timer);
  fam.timer = setInterval(() => { if (!document.hidden) refreshFamily(); }, 15000);   // live while the list is open
}
// «＋ Νέο άτομο» (and, v23, «＋ Προσθήκη νέου προφίλ» in the Άτομα panel) only while this device has NO owner's
// profile (server token, or the on-device «me» person). Once you have one, both are hidden; a dead token (v20) or
// «Αποσύνδεση / επαναφορά» clears it and both come back.
function hasOwnProfile() { return !!cfg.token || (localPeople || []).some((p) => p.me); }
function syncEnrollBtn() {
  const own = hasOwnProfile();
  $('btnEnroll').classList.toggle('hidden', own || mode === 'enroll');
  $('pAddNew').classList.toggle('hidden', own);
  $('pResetDevice').classList.toggle('hidden', !own);
}
// v20: the server says the stored token is dead (profile deleted in the dashboard / token changed).
// Only the server's own answer counts (code 'bad_token', or 404 from /people/me) — never a network error.
function isDeadToken(e, fromMe = false) { return !!e && (e.code === 'bad_token' || (fromMe && e.status === 404)); }
// Forget this device's server profile (token + my id) so «＋ Νέο άτομο» comes back. Nothing is deleted on the server.
function forgetServerProfile() {
  if (!cfg.token && cfg.personId == null) return false;
  Object.assign(cfg, { token: '', personId: null, name: '', enabled: false }); server.saveCfg(cfg);
  srv.offline = false;
  for (const t of tracker.tracks) if (t.srv) { t.srv = false; t.label = null; t.message = ''; t.objectId = ''; t.personId = null; t.showName = true; t.sizes = null; t.style = null; }
  tracker.relabel(); $('srvMe').classList.add('hidden'); syncServerUi();
  if (mode === 'enroll' && !en.person) setupEnrollServer(null, true);   // enrolment open: show name + key fields again
  return true;
}
// A message in the settings panel with a «＋ Νέο άτομο» button right under it.
function infoWithEnroll(text) {
  const info = $('srvInfo'); info.textContent = text;
  const b = document.createElement('button'); b.type = 'button'; b.className = 'primary info-enroll'; b.textContent = '＋ Νέο άτομο';
  b.onclick = () => { closePeople(); openEnroll(); };
  info.appendChild(document.createElement('br')); info.appendChild(b);
}
function closePeople() { $('people').classList.add('hidden'); syncShot(); clearInterval(fam.timer); fam.timer = 0; }
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
  $('enroll').classList.remove('hidden'); syncShot();
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
$('btnStart').onclick = () => { if (camStarting || ready) return; unlockAudio(); goFullscreen(); start(); };

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
$('pAddNew').onclick = () => { if (hasOwnProfile()) return syncEnrollBtn(); closePeople(); openEnroll(); };
// v20: «Αποσύνδεση / επαναφορά αυτής της συσκευής» — forget my profile on THIS phone only (server profile untouched)
$('pResetDevice').onclick = async () => {
  if (!confirm('Να ξεχάσει αυτή η συσκευή το προφίλ σου;\nΤο προφίλ στον server ΔΕΝ διαγράφεται. Μετά θα εμφανιστεί ξανά το «＋ Νέο άτομο».')) return;
  forgetServerProfile();
  for (const p of localPeople) if (p.me) { delete p.me; await db.putPerson(p); }
  await reloadPeople(); syncEnrollBtn();
  infoWithEnroll('Η συσκευή επανήλθε ✓ — πάτα «＋ Νέο άτομο» για να καταχωριστείς ξανά.');
  setStatus('Η συσκευή επανήλθε — πάτα «＋ Νέο άτομο».');
  refreshFamily();
};
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
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `noera-backup-${new Date().toISOString().slice(0, 10)}.json` });
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
$('optSound').checked = settings.sound !== false;
$('optSound').onchange = (e) => { settings.sound = e.target.checked; db.saveSettings(settings); if (e.target.checked) unlockAudio(); };

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
// v18 multi-face: every face in view is checked (safety limit SRV_MAX_FACES for CPU / battery), in batches of
// SRV_BATCH per request. Most overdue first (never-checked faces before everyone else), so nobody starves; among
// equally due faces the larger / more centred ones go first. Known faces are re-checked every 1.5 s, unknown 350 ms.
const SRV_BATCH = 4, SRV_MAX_FACES = 12, SRV_RECHECK_KNOWN = 1500, SRV_RECHECK_UNKNOWN = 350;
const SRV_MIN_PX = 36, SRV_MAX_YAW = 75;
const srv = { inflight: false, last: 0, offline: false, retryAt: 0, calls: 0, ok: 0, lastError: null, batches: [] };

function whyNot(t) {   // why this face is not sent to the server (null = it is sent)
  if (t.missed > 0) return 'lost';
  if (t.wpx < SRV_MIN_PX) return 'small';
  if (Math.abs(t.pose.yaw) > SRV_MAX_YAW) return 'turned';
  return null;
}
function srvOrder(tracks, vw, vh, now) {
  const asp = vh ? vw / vh : 1, diag = Math.hypot(0.5 * asp, 0.5);   // box is normalised 0..1
  const live = tracks.filter((t) => !whyNot(t))
    .map((t) => {
      const due = now - (t.srvAt || 0) - (t.srv ? SRV_RECHECK_KNOWN : SRV_RECHECK_UNKNOWN);
      const bx = (t.box.x0 + t.box.x1) / 2, by = (t.box.y0 + t.box.y1) / 2;
      const centre = 1 - Math.min(1, Math.hypot((bx - 0.5) * asp, by - 0.5) / diag);
      return { t, due, never: !t.srvAt, prio: t.wpx * (0.5 + centre) };
    });
  // safety cap: if more than SRV_MAX_FACES are in view, keep the largest / most centred ones
  const kept = live.sort((a, b) => b.prio - a.prio).slice(0, SRV_MAX_FACES);
  return kept.filter((x) => x.due > 0)
    .sort((a, b) => (b.never - a.never) || (Math.round(b.due / 250) - Math.round(a.due / 250)) || (b.prio - a.prio))
    .map((x) => x.t);
}

async function serverStep(tracks, vw, vh, now) {
  if (srv.inflight || now - srv.last < SRV_INTERVAL) return;
  if (srv.offline && now < srv.retryAt) return;
  const cand = srvOrder(tracks, vw, vh, now).slice(0, SRV_BATCH);
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
  srv.batches.push(faces.map((f) => f.id)); if (srv.batches.length > 50) srv.batches.shift();
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
        t.srvMiss = 0; t.srvUnknownAt = 0; t.srv = true; t.label = f.name; t.personId = f.person_id; t.sim = f.similarity;
        t.objectId = v.objectId; t.message = v.text; t.showName = v.showName; t.sizes = v.sizes; t.style = v.style;
        if (!t.recognisedAt) t.recognisedAt = performance.now();
      } else {
        t.srvMiss = (t.srvMiss || 0) + 1; t.srvUnknownAt = performance.now();
        if (t.srv && t.srvMiss >= 2) { t.srv = false; t.label = null; t.message = ''; t.objectId = ''; t.personId = null; t.showName = true; t.sizes = null; t.style = null; }
      }
    }
  }).catch((e) => {
    srv.lastError = e;
    if (isDeadToken(e) && forgetServerProfile()) { setStatus('⚠️ Το προφίλ σου δεν βρέθηκε στον server (ίσως διαγράφηκε). Πάτα «＋ Νέο άτομο» για να καταχωριστείς ξανά.'); refreshFamily(); return; }
    const wasOffline = srv.offline;
    srv.offline = true;
    srv.retryAt = performance.now() + (e.status === 401 ? 15000 : 5000);
    if (!wasOffline) {
      for (const t of tracker.tracks) if (t.srv) { t.srv = false; t.label = null; t.message = ''; t.objectId = ''; t.showName = true; t.sizes = null; t.style = null; }
      tracker.relabel();
      const local = gallery.people.length ? 'συνεχίζω με τα άτομα αυτής της συσκευής' : 'θα ξαναδοκιμάσω σε λίγο';
      setStatus(e.status === 401 ? (adv ? '⚠️ Server: το token δεν ισχύει — δες τις Ρυθμίσεις' : '⚠️ Το προφίλ σου δεν βρέθηκε — δες τις Ρυθμίσεις')
        : `⚠️ Εκτός σύνδεσης — ${local}`);
    }
  }).finally(() => { srv.inflight = false; });
}

// v18: «γιατί άγνωστο» — small hint under faces without a name, ONLY in the hidden advanced mode
const WHY_TEXT = { small: 'πολύ μικρό / μακριά', turned: 'πολύ γυρισμένο', lost: 'χάθηκε', unknown: 'δεν αναγνωρίστηκε', wait: 'έλεγχος…' };
const whyEls = new Map();
function renderWhy(tracks, vw, vh) {
  const live = new Set();
  if (adv && mode === 'scan' && serverOn() && !srv.offline && vw) {
    const W = labels.W, H = labels.H, sc = Math.max(W / vw, H / vh), ox = (W - vw * sc) / 2, oy = (H - vh * sc) / 2;
    for (const t of tracks) {
      if (t.label || t.missed > 3) continue;
      const k = whyNot(t) || (t.srvUnknownAt ? 'unknown' : 'wait');
      t.why = k; live.add(t.id);
      let el = whyEls.get(t.id);
      if (!el) { el = document.createElement('div'); el.className = 'why'; $('bubbles').appendChild(el); whyEls.set(t.id, el); }
      const txt = '? ' + WHY_TEXT[k];
      if (el.textContent !== txt) el.textContent = txt;
      let x0 = t.box.x0 * vw * sc + ox, x1 = t.box.x1 * vw * sc + ox; const y1 = t.box.y1 * vh * sc + oy;
      if (labels.mirror) [x0, x1] = [W - x1, W - x0];
      el.style.transform = `translate(${(x0 + x1) / 2}px, ${y1 + 4}px) translate(-50%, 0)`;
    }
  }
  for (const [id, el] of whyEls) if (!live.has(id)) { el.remove(); whyEls.delete(id); }
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
        : 'Γράψε το όνομά σου, το κλειδί πρόσβασης και πάτα ▶ Αυτόματη λήψη.');
      applyOpenEnrollment(); hint();
      const shown = $('enMsg').textContent;
      checkOpenEnrollment().then(() => {
        if (mode !== 'enroll' || existing !== en.person) return;
        if (srvReach === false && !en.auto && !en.samples.length) {
          // Server unreachable: fall back to on-device enrollment (the user can tick ☁️ again to retry).
          $('enToSrv').checked = false; $('enSrvFields').classList.add('hidden');
          setMsg('Δεν υπάρχει σύνδεση τώρα — η καταχώριση θα γίνει μόνο σε αυτή τη συσκευή. Βάλε όνομα και πάτα ▶ (ή τσέκαρε ξανά το ☁️ για να ξαναδοκιμάσεις).');
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
      if (!key && srvOpen !== true) { applyOpenEnrollment(); setMsg('Χρειάζεται το κλειδί πρόσβασης (στο ζητάει μόνο αυτή τη φορά).'); return; }
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
      setStatus('Αποθηκεύτηκε ✓ Το προφίλ σου είναι έτοιμο.');
      setTimeout(() => { if (mode === 'enroll' && $('tokSheet').classList.contains('hidden')) closeEnroll(); }, 1200);   // v17: close soon after a successful save
    } else {
      const miss = enr ? enr.missing_poses : [];
      const need = enr ? enr.frames_still_needed : 0;
      setMsg(`${head} Χρειάζονται ακόμα ${need} λήψεις${miss.length ? ` — λείπουν: ${server.posesEl(miss)}` : ''}. Πάτα ξανά ▶ Αυτόματη λήψη ή 📸.`);
    }
  } catch (e) {
    if (isDeadToken(e) && forgetServerProfile()) {
      setupEnrollServer(null, true);
      setMsg('Το παλιό σου προφίλ δεν υπάρχει πια στον server. Γράψε το όνομά σου και πάτα ξανά «Αποθήκευση» για νέο προφίλ (οι λήψεις κρατήθηκαν).');
      return;
    }
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
    : server.isDefaultUrl(cfg) ? 'Ο προεπιλεγμένος server. Άδειασε το πεδίο για χρήση μόνο στη συσκευή.'
      : 'Δική σου διεύθυνση. Άδειο = μόνο στη συσκευή.';
  $('srvDefault').classList.toggle('hidden', server.isDefaultUrl(cfg));
  $('srvToken').value = cfg.token || '';
  $('srvOn').checked = !!cfg.enabled;
  $('srvOn').disabled = !(cfg.url && cfg.token);
  syncEnrollBtn();
  $('privacyNote').textContent = serverOn()
    ? 'Λειτουργία server: για την αναγνώριση στέλνεται στον server μόνο ένα αριθμητικό αποτύπωμα κάθε προσώπου (όχι εικόνα).'
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
    for (const t of tracker.tracks) { t.srv = false; t.message = ''; t.objectId = ''; t.showName = true; t.sizes = null; t.style = null; }
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
      if (hasCap('styles')) f.text_style = dispStyle;
      if (hasCap('sizes')) Object.assign(f, { size_name: +$('szName').value, size_text: +$('szText').value, size_object: +$('szObj').value });
      const empty = [['message1', f.message, 'το Μήνυμα 1'], ['message2', f.message2, 'το Μήνυμα 2']].filter(([k, t]) => items.includes(k) && !t).map((x) => x[2]);
      if (empty.length) note = ` (${empty.join(' και ')} είναι κενό — δεν θα φαίνεται)`;
    }
    const btn = $('srvMsgSave'); btn.disabled = true;
    try {
      await api.patchMe(cfg.personId, f); dispDirty = false;
      msgHistAdd(f.message2, f.message);   // v23: remember what I typed (most recent first)
      const ok = (hasCap('display') ? 'Αποθηκεύτηκε ✓' : 'Το μήνυμα αποθηκεύτηκε ✓') + note;
      $('srvInfo').textContent = ok;
      closePeople(); setStatus(ok);   // v17: a successful save closes the settings panel
    }
    catch (e) {   // failure: panel stays open with the error
      if (isDeadToken(e) && forgetServerProfile()) infoWithEnroll('⚠️ Το προφίλ σου δεν βρέθηκε στον server (ίσως διαγράφηκε). Πάτα «＋ Νέο άτομο» για να καταχωριστείς ξανά.');
      else $('srvInfo').textContent = '⚠️ ' + errMsg(e);
    }
    finally { btn.disabled = false; }
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
  renderMsgHist();
  for (const id of ['szName', 'szText', 'szObj']) $(id).oninput = () => { dispDirty = true; showSize(id); updatePreview(); };
  for (const b of $('stylePick').children) b.onclick = () => { pickStyle(b.dataset.style); dispDirty = true; };
  setupGroups();
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

let dispObj = DEFAULT_OBJECT, dispStyle = 'bold';
const STYLE_NAMES = { bold: 'Τολμηρό', curved: 'Καμπυλωτό', soft: 'Ήπιο' };
function pickStyle(st) {
  dispStyle = STYLE_NAMES[st] ? st : 'bold';
  for (const b of $('stylePick').children) { const on = b.dataset.style === dispStyle; b.classList.toggle('sel', on); b.setAttribute('aria-checked', on); }
  updatePreview();
}
// «Ποιος με βλέπει» (server 0.5.0): Όλοι / only members of the groups I tick
let privMe = null, grpSearchTimer = 0, grpSearchSeq = 0;
function setupGroups() {
  const info = (t) => { $('grpInfo').textContent = t; };
  for (const id of ['privAll', 'privGroups']) $(id).onchange = async () => {
    const mode = $('privGroups').checked ? 'groups' : 'everyone';
    try { await api.patchMe(cfg.personId, { visibility: mode }); info(mode === 'everyone' ? 'Σε βλέπουν όλοι ✓' : 'Σε βλέπουν μόνο οι ομάδες που τσεκάρεις ✓'); await refreshGroups(); }
    catch (e) { info('⚠️ ' + errMsg(e)); await refreshGroups(); }
  };
  $('grpSearch').oninput = () => { clearTimeout(grpSearchTimer); grpSearchTimer = setTimeout(searchGroups, 350); };
  $('grpCreate').onclick = async () => {
    const name = $('grpNewName').value.trim().replace(/\s+/g, ' ');
    if (name.length < 2) return info('⚠️ Δώσε όνομα με τουλάχιστον 2 γράμματα.');
    try {
      const r = await api.createGroup(name);
      $('grpNewName').value = '';
      await seeMe(r.group.id, true, r.groups);
      info(`Η ομάδα «${r.group.name}» φτιάχτηκε ✓ — πες στους άλλους να την αναζητήσουν και να μπουν.`);
    } catch (e) { info('⚠️ ' + errMsg(e)); }
  };
}
async function seeMe(gid, on, groups) {   // tick / untick «με βλέπει» for one of my groups
  const ids = new Set((groups || []).filter((g) => g.sees_me).map((g) => g.id));
  on ? ids.add(gid) : ids.delete(gid);
  await api.patchMe(cfg.personId, { visible_groups: [...ids] });
  await refreshGroups();
}
async function searchGroups() {
  const q = $('grpSearch').value.trim(), ul = $('grpResults'), seq = ++grpSearchSeq;
  if (q.length < 2) { ul.innerHTML = q ? '<li class="small">Γράψε τουλάχιστον 2 γράμματα.</li>' : ''; return; }
  try {
    const { groups } = await api.searchGroups(q);
    if (seq !== grpSearchSeq) return;
    ul.innerHTML = groups.length ? '' : '<li class="small">Δεν βρέθηκε ομάδα. Μπορείς να τη φτιάξεις παρακάτω.</li>';
    for (const g of groups) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="gname"></span><button type="button"></button>';
      li.querySelector('.gname').textContent = g.name;
      const b = li.querySelector('button');
      if (g.member) { b.textContent = '✓ Είσαι μέλος'; b.disabled = true; }
      else {
        b.textContent = 'Συμμετοχή';
        b.onclick = async () => {
          b.disabled = true;
          try { const r = await api.joinGroup(g.id); await seeMe(g.id, true, r.groups); $('grpInfo').textContent = `Μπήκες στην ομάδα «${g.name}» ✓`; searchGroups(); }
          catch (e) { b.disabled = false; $('grpInfo').textContent = '⚠️ ' + errMsg(e); }
        };
      }
      ul.appendChild(li);
    }
  } catch (e) { if (seq === grpSearchSeq) ul.innerHTML = `<li class="small">⚠️ ${escapeHtml(errMsg(e))}</li>`; }
}
async function refreshGroups(me = null) {
  const box = $('srvPrivBox');
  if (!hasCap('groups') || !cfg.token) { box.classList.add('hidden'); return; }
  try {
    if (!me) me = await api.me();
    privMe = me;
    const mode = (me.privacy && me.privacy.mode) || (me.visibility === 'family' ? 'everyone' : 'groups');
    $('privAll').checked = mode === 'everyone'; $('privGroups').checked = mode === 'groups';
    const { groups } = await api.myGroups();
    const ul = $('grpMine'); ul.innerHTML = '';
    const ticked = groups.filter((g) => g.sees_me).length;
    $('privNote').textContent = mode === 'everyone'
      ? 'Όποιος έχει την εφαρμογή σε αναγνωρίζει και βλέπει ό,τι διάλεξες πάνω από το κεφάλι σου.'
      : (ticked ? 'Τσέκαρε ποιες ομάδες σε βλέπουν. Σε αναγνωρίζουν μόνο τα μέλη τους· οι άλλοι σε βλέπουν σαν άγνωστο πρόσωπο.'
        : '⚠️ Δεν έχεις τσεκάρει καμία ομάδα — τώρα δεν σε αναγνωρίζει κανείς άλλος. Τσέκαρε μία από τις ομάδες σου (ή μπες / φτιάξε μία).');
    if (!groups.length) ul.innerHTML = '<li class="small">Δεν είσαι ακόμα σε καμία ομάδα. Βρες μία ή φτιάξε νέα.</li>';
    for (const g of groups) {
      const li = document.createElement('li');
      li.innerHTML = '<label class="check"><input type="checkbox"> <span class="gname"></span></label> <span class="small"></span><button type="button" class="danger">Αποχώρηση</button>';
      li.querySelector('.gname').textContent = g.name;
      const who = (g.member_names || []).filter(Boolean);
      li.querySelector('.small').textContent = `${plural(g.members)}` + (who.length ? ': ' + who.slice(0, 6).join(', ') + (who.length > 6 ? '…' : '') : '');
      const cb = li.querySelector('input');
      cb.checked = !!g.sees_me; cb.disabled = mode !== 'groups'; cb.title = 'Με βλέπει';
      cb.setAttribute('aria-label', `Η ομάδα «${g.name}» με βλέπει`);
      cb.onchange = async () => {
        try { await seeMe(g.id, cb.checked, groups); $('grpInfo').textContent = cb.checked ? `Η ομάδα «${g.name}» σε βλέπει ✓` : `Η ομάδα «${g.name}» δεν σε βλέπει πια ✓`; }
        catch (e) { cb.checked = !cb.checked; $('grpInfo').textContent = '⚠️ ' + errMsg(e); }
      };
      li.querySelector('button').onclick = async () => {
        if (!confirm(`Αποχώρηση από την ομάδα «${g.name}»;`)) return;
        try { await api.leaveGroup(g.id); $('grpInfo').textContent = `Αποχώρησες από την ομάδα «${g.name}».`; await refreshGroups(); if ($('grpSearch').value.trim()) searchGroups(); }
        catch (e) { $('grpInfo').textContent = '⚠️ ' + errMsg(e); }
      };
      ul.appendChild(li);
    }
    box.classList.remove('hidden');
  } catch (e) { $('grpInfo').textContent = '⚠️ ' + errMsg(e); }
}
function pickObject(id) {
  dispObj = objectInfo(id).id;
  const box = $('objPick'); let sel = null;
  for (const b of box.children) { b.classList.toggle('sel', b.dataset.obj === dispObj); if (b.dataset.obj === dispObj) sel = b; }
  if (sel && box.clientHeight) {   // ~44 objects: keep the chosen one visible inside the scrolling grid (not the page)
    const r = sel.getBoundingClientRect(), br = box.getBoundingClientRect();
    if (r.top < br.top) box.scrollTop += r.top - br.top - 4; else if (r.bottom > br.bottom) box.scrollTop += r.bottom - br.bottom + 4;
  }
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
  name.hidden = !items.includes('name');
  const nm = cfg.name || 'Όνομα', fpx = 20 * +$('szName').value, st = hasCap('styles') ? dispStyle : 'bold';
  name.className = 'pv-name sty-' + st;
  name.style.fontSize = fpx.toFixed(0) + 'px';
  if (st === 'curved') {   // the name on a gentle arc, like the 3D label
    const w = Math.max(60, nm.length * fpx * 0.72), h = fpx * 1.6;
    name.innerHTML = `<svg width="${w.toFixed(0)}" height="${h.toFixed(0)}" viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}" aria-hidden="true"><path id="pvArc" d="M 4 ${(h - 2).toFixed(1)} Q ${(w / 2).toFixed(1)} ${(-h * 0.35).toFixed(1)} ${(w - 4).toFixed(1)} ${(h - 2).toFixed(1)}" fill="none"/><text text-anchor="middle" font-weight="800" font-size="${fpx.toFixed(0)}" fill="#fff4e6" stroke="#ef6c00" stroke-width="${(fpx / 14).toFixed(2)}" paint-order="stroke"><textPath href="#pvArc" startOffset="50%"></textPath></text></svg>`;
    name.querySelector('textPath').textContent = nm;
  } else name.textContent = nm;
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
      infoWithEnroll('☁️ Συνδεδεμένος ✓ — δεν έχεις ακόμα προφίλ. Πάτα «＋ Νέο άτομο» και καταχώρισε τον εαυτό σου'
        + (srvOpen ? '' : ' (θα χρειαστείς το κλειδί πρόσβασης)') + (adv ? ', ή βάλε το token σου.' : '.'));
      return;
    }
    let me;
    try { me = await api.me(); } catch (e) { e.fromMe = true; throw e; }
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
    for (const el of document.querySelectorAll('#srvMe .styles-only')) el.classList.toggle('hidden', !(disp && hasCap('styles')));
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
        pickStyle(me.text_style || 'bold');
        pickObject(me.object_id || DEFAULT_OBJECT);
      }
    }
    refreshGroups(me);   // 0.5.0 only; hidden on older servers
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
    if (isDeadToken(e, e.fromMe)) { forgetServerProfile(); infoWithEnroll('⚠️ Το προφίλ σου δεν βρέθηκε στον server (ίσως διαγράφηκε). Πάτα «＋ Νέο άτομο» για να καταχωριστείς ξανά.'); }
    else if (e.status === 401) info.textContent = adv ? '⚠️ ' + server.errEl(e) : '⚠️ Το προφίλ σου δεν βρέθηκε στον server (ίσως διαγράφηκε). Πάτα «＋ Νέο άτομο» για να καταχωριστείς ξανά.';
    else info.textContent = '☁️ Εκτός σύνδεσης — θα ξαναδοκιμάσω όταν ανοίξεις πάλι τις ρυθμίσεις.';
    if (adv) advInfo.textContent = '⚠️ ' + server.errEl(e) + (e.code === 'offline' ? ' — έλεγξε τη διεύθυνση.' : '');
  }
}

// ---------- v21/v22: screenshot («Στιγμιότυπο») ----------
// One PNG of what the camera screen shows: the video frame the labels were drawn for (mirrored like on screen),
// the three.js overlay (3D names / objects), the message bubbles and (advanced) «why» hints. No UI chrome.
// The WebGL canvas has no preserveDrawingBuffer (keeps every frame fast): the scene is re-rendered and copied
// synchronously in the same task, so its drawing buffer is still valid.
let shotBusy = false;
function cameraVisible() {
  return ready && mode === 'scan' && !!video.videoWidth && ['people', 'enroll', 'start', 'tokSheet'].every((id) => $(id).classList.contains('hidden'));
}
function syncShot() { $('btnShot').classList.toggle('hidden', !cameraVisible()); }
function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
// draw an HTML overlay element (bubble / why) onto the 2D context at its on-screen place and look
function drawHtmlLabel(g, el) {
  const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
  const cs = getComputedStyle(el), pl = parseFloat(cs.paddingLeft) || 0, pt = parseFloat(cs.paddingTop) || 0;
  const fs = parseFloat(cs.fontSize) || 16, lh = parseFloat(cs.lineHeight) || fs * 1.3, rad = parseFloat(cs.borderTopLeftRadius) || 0;
  g.save();
  if (el.classList.contains('bubble')) { g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 10; g.shadowOffsetY = 2; }
  g.fillStyle = cs.backgroundColor; roundRect(g, r.left, r.top, r.width, r.height, rad); g.fill();
  g.restore();
  g.save();
  g.fillStyle = cs.color; g.font = `${cs.fontWeight} ${fs}px ${cs.fontFamily}`; g.textBaseline = 'middle';
  const center = cs.textAlign === 'center', maxW = r.width - 2 * pl + 1;
  const lines = [];
  for (const para of (el.textContent || '').split('\n')) {   // wrap like the browser (word by word)
    let cur = '';
    for (const w of para.split(/(\s+)/)) {
      const t = cur + w;
      if (cur && g.measureText(t.trimEnd()).width > maxW) { lines.push(cur.trimEnd()); cur = w.trimStart(); } else cur = t;
    }
    lines.push(cur.trimEnd());
  }
  g.textAlign = center ? 'center' : 'left';
  const x = center ? r.left + r.width / 2 : r.left + pl, y0 = r.top + pt + lh / 2;
  lines.forEach((ln, i) => g.fillText(ln, x, y0 + i * lh));
  g.restore();
}
function composeShot() {
  const W = window.innerWidth, H = window.innerHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
  const c = document.createElement('canvas'); c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  // the frame the current labels belong to (frameCanvas), else the live video; object-fit: cover
  const vw = video.videoWidth, vh = video.videoHeight;
  const src = frameCanvas.width === vw && frameCanvas.height === vh ? frameCanvas : video;
  const sc = Math.max(W / vw, H / vh), dw = vw * sc, dh = vh * sc;
  g.save(); if (labels.mirror) { g.translate(W, 0); g.scale(-1, 1); }   // like #video.mirror (CSS scaleX(-1))
  g.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh); g.restore();
  // three.js overlay: render now and copy in the same task (no preserveDrawingBuffer needed)
  try { labels.renderer.render(labels.scene, labels.camera); g.drawImage(overlay, 0, 0, W, H); } catch (e) { console.warn(e); }
  for (const el of $('bubbles').children) drawHtmlLabel(g, el);
  return c;
}
const pad2 = (n) => String(n).padStart(2, '0');
function shotName(d = new Date()) {
  return `noera-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.png`;
}
let toastT = 0;
function toast(t) {
  const n = $('toast'); n.textContent = t; n.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => n.classList.remove('show'), 2200);
}
function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function takeShot() {
  if (shotBusy || !cameraVisible()) return null;
  shotBusy = true;
  const b = $('btnShot'); b.classList.add('press'); setTimeout(() => b.classList.remove('press'), 160);
  try {
    const c = composeShot();
    const fl = $('flash'); fl.classList.remove('on'); void fl.offsetWidth; fl.classList.add('on');
    if (settings.sound !== false) playShutter();
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    if (!blob) throw new Error('toBlob');
    const name = shotName();
    window.__ar.lastShot = { blob, name, width: c.width, height: c.height, size: blob.size, type: blob.type, via: '' };
    // v22: save straight away like a normal screenshot (blob download → Downloads/gallery), on mobile too.
    // Web Share only as a fallback when the download attempt itself throws.
    try {
      if (window.__ar.failDownload) throw new Error('download (test)');
      download(blob, name); window.__ar.lastShot.via = 'download'; toast('Στιγμιότυπο αποθηκεύτηκε ✓');
    } catch (de) {
      console.warn('download failed, share fallback', de);
      const file = typeof File === 'function' ? new File([blob], name, { type: 'image/png' }) : null;
      if (!(file && navigator.canShare && navigator.share && navigator.canShare({ files: [file] }))) throw de;
      try { await navigator.share({ files: [file], title: 'Noera' }); window.__ar.lastShot.via = 'share'; toast('Στιγμιότυπο αποθηκεύτηκε ✓'); }
      catch (e) { if (e && e.name === 'AbortError') window.__ar.lastShot.via = 'share-cancel'; else throw e; }
    }
    return window.__ar.lastShot;
  } catch (e) {
    console.warn(e); toast('Δεν έγινε το στιγμιότυπο'); return null;
  } finally { shotBusy = false; }
}
$('btnShot').onclick = () => { takeShot(); };
window.__ar.shot = takeShot; window.__ar.shotName = shotName; window.__ar.composeShot = composeShot; window.__ar.frameCanvas = frameCanvas;

