// v34: missing-person safety, emergency card, waiting messages, "where we met",
// accessibility (voice / large text / contrast), illustrated tutorial, memory photo.
import { t as tr, getLang, applyI18n, locale } from './i18n.js';

const $ = (id) => document.getElementById(id);
const TUT = ['t1','t2','t3','t4','t5','t6','t7','t8','t9','t10','t11','t12','t13','t14'];
// v43: approved Noera avatar poses (same character, logo on the shirt, varied heads).
// Dedicated poses for install, events, met, where-met, emergency, missing, easy, privacy.
// Remaining steps reuse the closest of the original four.
const TUT_ART = {
  t1: '01-welcome', t2: 't02-install', t3: '02-photos', t4: '03-above-head',
  t5: '03-above-head', t6: '01-welcome', t7: 't07-events', t8: 't08-met',
  t9: '03-above-head', t10: 't10-where-met', t11: 't11-emergency', t12: 't12-missing',
  t13: 't13-easy', t14: 't14-privacy',
};
const A11Y_KEY = 'ar-names-a11y';
const MET_NOTES_KEY = 'ar-names-met-notes';
const EM_MODE_KEY = 'ar-names-emergency-mode';

let ctx = {};
let tutStep = 0;
let safetyList = [];
let waitList = [];
let lastEvents = [];
let spoken = new Map(); // personId -> last spoken at
let hudEls = new Map();
let askDone = null;

function api() { return ctx.api; }
function hasCap(f) { return typeof ctx.hasCap === 'function' && ctx.hasCap(f); }
function toast(m) { if (ctx.toast) ctx.toast(m); }
function cfg() { return ctx.cfg || {}; }

function loadJson(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v == null ? fallback : v; } catch (_) { return fallback; }
}
function saveJson(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) {} }

export function a11yState() {
  const s = loadJson(A11Y_KEY, {}) || {};
  return { speak: !!s.speak, large: !!s.large, contrast: !!s.contrast, care: !!s.care };
}
export function emergencyModeOn() { return loadJson(EM_MODE_KEY, false) === true; }

export function applyA11y() {
  const s = a11yState();
  document.body.classList.toggle('a11y-large', !!s.large);
  document.body.classList.toggle('a11y-contrast', !!s.contrast);
  if ($('a11ySpeak')) $('a11ySpeak').checked = !!s.speak;
  if ($('a11yLarge')) $('a11yLarge').checked = !!s.large;
  if ($('a11yContrast')) $('a11yContrast').checked = !!s.contrast;
  if ($('a11yCare')) $('a11yCare').checked = !!(s.care || (s.speak && s.large && s.contrast));
}

function setA11y(patch) {
  const s = { ...a11yState(), ...patch };
  if (patch.care === true) { s.speak = s.large = s.contrast = s.care = true; }
  if (patch.care === false && s.care) { s.speak = s.large = s.contrast = s.care = false; }
  s.care = !!(s.speak && s.large && s.contrast);
  saveJson(A11Y_KEY, s);
  applyA11y();
}

export function metNotes() { return loadJson(MET_NOTES_KEY, {}) || {}; }
export function setMetNote(pid, rec) {
  const all = metNotes();
  all[String(pid)] = { ...((all[String(pid)] || {})), ...rec, at: Date.now() };
  saveJson(MET_NOTES_KEY, all);
}
export function metLineFor(pid, name) {
  const n = metNotes()[String(pid)];
  if (!n) return '';
  if (n.note) return n.note;
  if (n.event && n.date) return tr('mem.auto', { event: n.event, date: n.date });
  return n.event || n.date || '';
}

function currentEventName() {
  const ev = (lastEvents || []).find((g) => g.kind === 'event' || g.is_event);
  return ev && ev.name ? ev.name : '';
}
export function setEvents(list) { lastEvents = list || []; }

function fmtDate(ts) {
  try { return new Date(ts || Date.now()).toLocaleDateString(locale(), { year: 'numeric', month: 'long', day: 'numeric' }); }
  catch (_) { return ''; }
}

export function maybeRememberMeet(pid, name) {
  if (!pid) return;
  const ev = currentEventName();
  if (!ev) return;
  const all = metNotes();
  const cur = all[String(pid)];
  if (cur && (cur.event || cur.note)) return;
  setMetNote(pid, { event: ev, date: fmtDate(Date.now()), name: name || '' });
}

export function speakName(name, personId) {
  const s = a11yState();
  if (!s.speak || !name || typeof speechSynthesis === 'undefined') return;
  const id = String(personId || name);
  const now = Date.now();
  if ((spoken.get(id) || 0) + 20000 > now) return;
  spoken.set(id, now);
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(tr('a11y.say', { name }));
    const lang = { el: 'el-GR', en: 'en-US', fr: 'fr-FR', de: 'de-DE' }[getLang()] || 'el-GR';
    u.lang = lang; u.rate = 0.95;
    speechSynthesis.speak(u);
  } catch (_) {}
}

// ---------- tutorial ----------
export function openTutorial(fromHelp) {
  tutStep = 0;
  if (fromHelp && ctx.closeHelpSheet) ctx.closeHelpSheet();
  if (ctx.closePeople) ctx.closePeople();
  renderTut();
  $('tutSheet').classList.remove('hidden');
  document.body.classList.add('tut-on');
  if (ctx.syncShot) ctx.syncShot();
}
export function closeTutorial() {
  $('tutSheet').classList.add('hidden');
  document.body.classList.remove('tut-on');
  if (ctx.syncShot) ctx.syncShot();
}
function renderTut() {
  const n = TUT.length, id = TUT[tutStep];
  $('tutStep').textContent = tr('tut.step', { i: tutStep + 1, n });
  $('tutHeading').textContent = tr('tut.' + id + '.t');
  $('tutBody').textContent = tr('tut.' + id + '.b');
  const file = tr('tut.' + id + '.img') || TUT_ART[id] || '01-welcome';
  const src = $('tutArtWebp'); if (src) src.srcset = 'tutorial/' + file + '.webp';
  $('tutArt').src = 'tutorial/' + file + '.png';
  $('tutArt').alt = tr('tut.' + id + '.t');
  $('tutPrev').disabled = tutStep <= 0;
  $('tutNext').textContent = tutStep >= n - 1 ? tr('tut.done') : tr('tut.next');
}
function tutNext() { if (tutStep >= TUT.length - 1) { closeTutorial(); return; } tutStep++; renderTut(); }
function tutPrev() { if (tutStep > 0) { tutStep--; renderTut(); } }

// ---------- simple yes/no sheet ----------
function ask(title, body, { yes, no } = {}) {
  return new Promise((resolve) => {
    askDone = resolve;
    $('askTitle').textContent = title || '';
    $('askBody').textContent = body || '';
    $('askYes').textContent = yes || tr('saf.yes');
    $('askNo').textContent = no || tr('saf.cancel');
    $('askSheet').classList.remove('hidden');
  });
}
function closeAsk(v) {
  $('askSheet').classList.add('hidden');
  const d = askDone; askDone = null; if (d) d(v);
}

// ---------- safety ----------
async function refreshSafety() {
  const box = $('safList'); if (!box) return;
  const can = hasCap('safety') && cfg().token;
  $('safNeed').classList.toggle('hidden', !!can);
  $('safCreate').classList.toggle('hidden', !can);
  $('safForm').classList.add('hidden');
  if (!can) { box.innerHTML = ''; $('safEmpty').classList.remove('hidden'); return; }
  try {
    const r = await api().listSafety();
    safetyList = r.profiles || [];
  } catch (e) { safetyList = []; toast('⚠️ ' + (ctx.errMsg ? ctx.errMsg(e) : e)); }
  renderSafetyList();
}
function statusLabel(st) {
  return st === 'active' ? tr('saf.active') : st === 'pending' ? tr('saf.pending') : st === 'closed' ? tr('saf.closed') : tr('saf.inactive');
}
function renderSafetyList() {
  const box = $('safList'); box.innerHTML = '';
  const open = safetyList.filter((p) => p.status !== 'closed');
  $('safEmpty').classList.toggle('hidden', open.length > 0);
  for (const p of open) {
    const el = document.createElement('div');
    el.className = 'scard saf-card';
    el.dataset.id = p.id;
    const enr = p.enrollment || {};
    const photosOk = !!(enr.active);
    const sights = (p.sightings || []).map((s) => {
      const when = s.created_at ? fmtDate(s.created_at * 1000) : '';
      const who = s.reporter_name || '';
      const loc = (s.lat != null && s.lon != null) ? `${Number(s.lat).toFixed(3)}, ${Number(s.lon).toFixed(3)}` : '';
      return `<li>${escapeHtml(who)} · ${escapeHtml(loc)} · ${escapeHtml(when)}</li>`;
    }).join('');
    el.innerHTML = `<h3>${escapeHtml(p.name)}</h3>
      <p class="small saf-msg">${escapeHtml(p.message)}</p>
      <p class="small">${escapeHtml(statusLabel(p.status))}</p>
      ${photosOk ? '' : `<p class="small">${escapeHtml(tr('saf.photosMore', { need: enr.frames_still_needed || enr.missing_poses && enr.missing_poses.length || '…' }))}</p>`}
      ${p.status === 'active' && sights ? `<p class="small">${escapeHtml(tr('saf.sights'))}</p><ul class="saf-sights">${sights}</ul>` : ''}
      <div class="row wrap saf-actions"></div>`;
    const row = el.querySelector('.saf-actions');
    const btn = (label, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = (cls || 'big') + ' big'; b.textContent = label; b.onclick = fn; row.appendChild(b); };
    if (!photosOk && p.status === 'inactive') btn(tr('saf.nextPhoto'), 'primary', () => startSafetyPhotos(p));
    if (photosOk && (p.status === 'inactive' || p.status === 'pending' && false)) btn(tr('saf.askMissing'), 'primary', () => activateSafety(p));
    if (photosOk && p.status === 'inactive') btn(tr('saf.askMissing'), 'primary', () => activateSafety(p));
    if (p.status === 'active' || p.status === 'pending') btn(tr('saf.found'), 'danger', () => foundSafety(p));
    box.appendChild(el);
  }
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function showSafForm() {
  $('safForm').classList.remove('hidden');
  $('safName').value = ''; $('safMsg').value = ''; $('safConsentNote').value = '';
  $('safConsentSelf').checked = false; $('safConsentGuard').checked = false;
  $('safDays').value = '7';
  $('safName').focus();
}
async function createSafety() {
  const name = ($('safName').value || '').trim();
  const message = ($('safMsg').value || '').trim();
  const note = ($('safConsentNote').value || '').trim();
  const kind = $('safConsentGuard').checked ? 'guardian' : ($('safConsentSelf').checked ? 'self' : '');
  if (!name || message.length < 8) { toast(tr('saf.needName')); return; }
  if (!kind || (kind === 'guardian' && note.length < 4) || (kind === 'self' && note.length < 2)) { toast(tr('saf.needConsent')); return; }
  const ttl = Math.min(30, Math.max(1, parseInt($('safDays').value, 10) || 7));
  try {
    const r = await api().createSafety({ name, message, consent_kind: kind, consent_note: note, ttl_days: ttl });
    $('safForm').classList.add('hidden');
    const p = r.profile;
    await refreshSafety();
    startSafetyPhotos(p);
  } catch (e) { toast('⚠️ ' + (ctx.errMsg ? ctx.errMsg(e) : e)); }
}
function startSafetyPhotos(p) {
  if (ctx.closePeople) ctx.closePeople();
  if (ctx.openSafetyEnroll) ctx.openSafetyEnroll(p.id, p.name);
}
async function activateSafety(p) {
  if (!(await ask(tr('saf.askMissing'), tr('saf.askMissingQ')))) return;
  try { await api().activateSafety(p.id); toast(tr('saf.pending')); await refreshSafety(); }
  catch (e) { toast('⚠️ ' + (ctx.errMsg ? ctx.errMsg(e) : e)); }
}
async function foundSafety(p) {
  if (!(await ask(tr('saf.found'), tr('saf.foundQ')))) return;
  try { await api().foundSafety(p.id); await refreshSafety(); }
  catch (e) { toast('⚠️ ' + (ctx.errMsg ? ctx.errMsg(e) : e)); }
}

export async function sendSighting(sid) {
  if (!(await ask(tr('saf.sight'), tr('saf.sightAsk')))) { toast(tr('saf.sightNo')); return; }
  const loc = await new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 10000 });
  });
  if (!loc) { toast(tr('saf.sightNeed')); return; }
  try {
    await api().sightSafety(sid, { granted: true, ...loc });
    toast(tr('saf.sightOk'));
  } catch (e) { toast('⚠️ ' + (ctx.errMsg ? ctx.errMsg(e) : e)); }
}
export async function reportSafety(sid) {
  try { await api().reportSafety(sid, { reason: 'other', note: '' }); toast(tr('saf.reportOk')); }
  catch (e) { toast('⚠️ ' + (ctx.errMsg ? ctx.errMsg(e) : e)); }
}

// ---------- emergency card (profile) ----------
export function fillEmergency(me) {
  if (!$('emCard')) return;
  $('emCard').value = (me && me.emergency_card) || '';
  const vis = (me && me.emergency_vis) || 'off';
  for (const r of document.querySelectorAll('input[name="emVis"]')) r.checked = r.value === vis;
}
export async function saveEmergency() {
  if (!hasCap('emergency')) return;
  const text = ($('emCard').value || '').trim();
  const vis = ([...document.querySelectorAll('input[name="emVis"]')].find((r) => r.checked) || {}).value || 'off';
  try {
    await api().patchMe(cfg().personId, { emergency_card: text, emergency_vis: vis });
    toast(tr('em.saved'));
  } catch (e) { toast('⚠️ ' + (ctx.errMsg ? ctx.errMsg(e) : e)); }
}
export function openEmCard(text) {
  $('emViewBody').textContent = text || '';
  $('emViewSheet').classList.remove('hidden');
}
function closeEmCard() { $('emViewSheet').classList.add('hidden'); }

// ---------- waiting messages ----------
async function refreshWaiting() {
  const box = $('waitList'); if (!box) return;
  if (!hasCap('waiting') || !cfg().token) { box.innerHTML = ''; $('waitEmpty').classList.remove('hidden'); $('waitBox').classList.add('hidden'); return; }
  $('waitBox').classList.remove('hidden');
  try { waitList = (await api().myWaiting()).messages || []; } catch (_) { waitList = []; }
  box.innerHTML = '';
  $('waitEmpty').classList.toggle('hidden', waitList.length > 0);
  for (const m of waitList) {
    const el = document.createElement('div');
    el.className = 'scard wait-row';
    const who = m.recipient_name || ('#' + m.recipient_id);
    el.innerHTML = `<p><b>${escapeHtml((m.emoji || '') + ' ' + (m.text || ''))}</b></p>
      <p class="small">${escapeHtml(who)}</p>`;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'big'; b.textContent = tr('wait.del');
    b.onclick = async () => { try { await api().deleteWaiting(m.id); await refreshWaiting(); } catch (e) { toast('⚠️ ' + (ctx.errMsg ? ctx.errMsg(e) : e)); } };
    el.appendChild(b);
    box.appendChild(el);
  }
}
export function openWaitForm(pid, name) {
  $('waitFor').textContent = name || '';
  $('waitText').value = '';
  $('waitEmoji').value = '';
  $('waitSheet').dataset.pid = pid;
  $('waitSheet').classList.remove('hidden');
  $('waitText').focus();
}
function closeWait() { $('waitSheet').classList.add('hidden'); }
async function sendWait() {
  const pid = +$('waitSheet').dataset.pid;
  const text = ($('waitText').value || '').trim();
  const emoji = ($('waitEmoji').value || '').trim();
  if (!text) return;
  try {
    await api().sendWaiting(pid, { text, emoji });
    closeWait();
    toast(tr('wait.sent'));
    await refreshWaiting();
  } catch (e) { toast('⚠️ ' + (ctx.errMsg ? ctx.errMsg(e) : e)); }
}

export function openMetNote(pid, name) {
  const n = metNotes()[String(pid)] || {};
  $('metFor').textContent = name || '';
  $('metAuto').textContent = (n.event || n.date) ? tr('mem.auto', { event: n.event || '', date: n.date || '' }) : '';
  $('metNote').value = n.note || '';
  $('metSheet').dataset.pid = pid;
  $('metSheet').dataset.name = name || '';
  $('metSheet').classList.remove('hidden');
  $('metNote').focus();
}
function closeMet() { $('metSheet').classList.add('hidden'); }
function saveMet() {
  const pid = $('metSheet').dataset.pid;
  setMetNote(pid, { note: ($('metNote').value || '').trim(), name: $('metSheet').dataset.name });
  closeMet();
  toast(tr('mem.saved'));
}

// ---------- HUD overlays (missing / waiting / emergency / met) ----------
function faceXY(t, vw, vh) {
  const labels = ctx.labels;
  if (!labels || !vw) return null;
  const W = labels.W, H = labels.H, sc = Math.max(W / vw, H / vh), ox = (W - vw * sc) / 2, oy = (H - vh * sc) / 2;
  let x0 = t.box.x0 * vw * sc + ox, x1 = t.box.x1 * vw * sc + ox;
  const y0 = t.box.y0 * vh * sc + oy;
  if (labels.mirror) [x0, x1] = [W - x1, W - x0];
  return { x: (x0 + x1) / 2, y: y0 };
}
export function tickHud(tracks, vw, vh) {
  const live = new Set();
  const host = $('v34hud'); if (!host) return;
  const scan = ctx.mode === 'scan';
  if (scan && vw) {
    for (const t of tracks) {
      if (t.missed > 3) continue;
      const pos = faceXY(t, vw, vh); if (!pos) continue;
      if (t.missing && t.missingId) {
        live.add('m' + t.id);
        let el = hudEls.get('m' + t.id);
        if (!el) {
          el = document.createElement('div');
          el.className = 'hud-card hud-miss';
          el.innerHTML = `<p class="hud-msg"></p><button type="button" class="primary big hud-sight"></button><button type="button" class="linkbtn hud-rep"></button>`;
          host.appendChild(el);
          hudEls.set('m' + t.id, el);
        }
        el.querySelector('.hud-msg').textContent = t.message || '';
        const sb = el.querySelector('.hud-sight'); sb.textContent = tr('saf.sight');
        sb.onclick = (e) => { e.stopPropagation(); sendSighting(t.missingId); };
        const rb = el.querySelector('.hud-rep'); rb.textContent = tr('saf.report');
        rb.onclick = (e) => { e.stopPropagation(); reportSafety(t.missingId); };
        el.style.transform = `translate(${pos.x}px, ${Math.max(8, pos.y - 12)}px) translate(-50%, -100%)`;
      } else if (t.waitingText) {
        live.add('w' + t.id);
        let el = hudEls.get('w' + t.id);
        if (!el) { el = document.createElement('div'); el.className = 'hud-card hud-wait'; host.appendChild(el); hudEls.set('w' + t.id, el); }
        el.textContent = t.waitingText;
        el.style.transform = `translate(${pos.x}px, ${Math.max(8, pos.y - 8)}px) translate(-50%, -100%)`;
      } else {
        if (t.emergencyText) {
          live.add('e' + t.id);
          let el = hudEls.get('e' + t.id);
          if (!el) {
            el = document.createElement('button');
            el.type = 'button';
            el.className = 'hud-chip';
            host.appendChild(el);
            hudEls.set('e' + t.id, el);
          }
          el.textContent = '🚑 ' + tr('em.open');
          el.onclick = (e) => { e.stopPropagation(); openEmCard(t.emergencyText); };
          el.style.transform = `translate(${pos.x}px, ${pos.y + ((t.box.y1 - t.box.y0) * (ctx.labels ? Math.max(ctx.labels.W / vw, ctx.labels.H / vh) : 1) * vh) + 8}px) translate(-50%, 0)`;
        }
        if (t.metLine) {
          live.add('n' + t.id);
          let el = hudEls.get('n' + t.id);
          if (!el) { el = document.createElement('div'); el.className = 'hud-met'; host.appendChild(el); hudEls.set('n' + t.id, el); }
          el.textContent = t.metLine;
          el.style.transform = `translate(${pos.x}px, ${Math.max(8, pos.y - 6)}px) translate(-50%, -100%)`;
        }
      }
    }
  }
  for (const [id, el] of hudEls) if (!live.has(id)) { el.remove(); hudEls.delete(id); }
}

export function applyRecognize(t, f) {
  t.missing = false; t.missingId = null; t.waitingText = ''; t.emergencyText = ''; t.metLine = '';
  if (f.status === 'missing') {
    t.missing = true;
    t.missingId = f.missing && f.missing.id;
    t.srvMiss = 0; t.srvUnknownAt = 0; t.srv = true;
    t.label = null; // no name
    t.message = (f.missing && f.missing.message) || f.message || '';
    t.personId = null; t.isSelf = false; t.showName = false; t.objectId = ''; t.sizes = null; t.style = null;
    t.acceptsPings = false;
    return 'missing';
  }
  if (f.status === 'known') {
    if (f.waiting && (f.waiting.text || f.waiting.emoji)) {
      t.waitingText = ((f.waiting.emoji || '') + ' ' + (f.waiting.text || '')).trim();
    }
    if (f.emergency && f.emergency.text) t.emergencyText = f.emergency.text;
    if (f.person_id && !f.is_self) {
      maybeRememberMeet(f.person_id, f.name);
      t.metLine = metLineFor(f.person_id, f.name);
      speakName(f.name, f.person_id);
    }
  }
  return f.status;
}

// ---------- memory photo ----------
export function drawMemoryPhoto({ a, b, date, where }) {
  const W = 1080, H = 1350;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#f4efe4'); bg.addColorStop(1, '#d9c8a8');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.fillStyle = '#1d4e89'; g.beginPath(); g.roundRect(80, 80, W - 160, H - 200, 48); g.fill();
  g.fillStyle = '#f7f3ea'; g.beginPath(); g.roundRect(100, 100, W - 200, H - 240, 40); g.fill();
  g.fillStyle = '#c25b12'; g.font = '700 54px system-ui, sans-serif'; g.textAlign = 'center';
  g.fillText('Noera', W / 2, 200);
  g.fillStyle = '#1d4e89'; g.font = '700 64px system-ui, sans-serif';
  const title = tr('meet.title');
  g.fillText(title, W / 2, 360);
  g.fillStyle = '#222'; g.font = '600 56px system-ui, sans-serif';
  const names = (a || '') + '  ·  ' + (b || '');
  wrapText(g, names, W / 2, 520, W - 280, 70);
  g.fillStyle = '#3a2f27'; g.font = '400 42px system-ui, sans-serif';
  const line = where ? tr('meet.at', { where, date: date || '' }) : tr('meet.atDate', { date: date || '' });
  wrapText(g, line, W / 2, 780, W - 280, 56);
  g.fillStyle = '#1d4e89'; g.font = '600 36px system-ui, sans-serif';
  g.fillText('Noera', W / 2, H - 160);
  return c;
}
function wrapText(g, text, x, y, max, lh) {
  const words = String(text || '').split(/\s+/);
  let line = '', yy = y;
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (g.measureText(t).width > max && line) { g.fillText(line, x, yy); line = w; yy += lh; }
    else line = t;
  }
  if (line) g.fillText(line, x, yy);
}

export async function shareOrSaveMemory(m) {
  const ev = (metNotes()[String(m.id)] || {}).event || currentEventName();
  const canvas = drawMemoryPhoto({ a: m.mine, b: m.name, date: fmtDate(m.at), where: ev });
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const file = new File([blob], 'noera-meet.png', { type: 'image/png' });
  const title = tr('meet.title');
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ title, files: [file], text: title });
      toast(tr('meet.shared'));
      return;
    }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const url = URL.createObjectURL(blob);
  $('memImg').src = url;
  $('memImgSheet').classList.remove('hidden');
  $('memDl').href = url; $('memDl').download = 'noera-meet.png';
}

export async function saveSafetyFrames(samples, sid, hooks) {
  const send = samples.filter((s) => s.blob && !s.sent);
  if (!send.length) return { ok: 0 };
  let i = 0, result = { ok: 0, rejected: {}, enrollment: null };
  for (const s of send) {
    if (hooks && hooks.onProgress) hooks.onProgress(++i, send.length);
    try {
      const r = await api().addSafetyFrame(sid, s.label, s.blob);
      s.sent = true; if (s.el) s.el.classList.add('ok'); result.ok++; result.enrollment = r.enrollment;
    } catch (e) {
      if (e.status === 0 || e.status === 401) throw e;
      s.sent = true; if (s.el) { s.el.classList.add('bad'); s.el.title = String(e); }
      result.rejected[String(e)] = (result.rejected[String(e)] || 0) + 1;
      if (e.detail && e.detail.enrollment) result.enrollment = e.detail.enrollment;
    }
  }
  return result;
}

export function syncV34Ui() {
  const me = cfg().token && hasCap;
  for (const el of document.querySelectorAll('.v34-safety')) el.classList.toggle('hidden', !(cfg().token && hasCap('safety')));
  for (const el of document.querySelectorAll('.v34-emergency')) el.classList.toggle('hidden', !(cfg().token && hasCap('emergency')));
  for (const el of document.querySelectorAll('.v34-waiting')) el.classList.toggle('hidden', !(cfg().token && hasCap('waiting')));
  if ($('emMode')) $('emMode').checked = emergencyModeOn();
}

export function initV34(c) {
  ctx = c || {};
  applyA11y();
  $('tutClose').onclick = closeTutorial;
  $('tutNext').onclick = tutNext;
  $('tutPrev').onclick = tutPrev;
  if ($('helpTut')) $('helpTut').onclick = () => openTutorial(true);
  $('safCreate').onclick = showSafForm;
  $('safFormGo').onclick = createSafety;
  $('safFormCancel').onclick = () => $('safForm').classList.add('hidden');
  $('safConsentSelf').onchange = () => { if ($('safConsentSelf').checked) $('safConsentGuard').checked = false; };
  $('safConsentGuard').onchange = () => { if ($('safConsentGuard').checked) $('safConsentSelf').checked = false; };
  $('a11ySpeak').onchange = () => setA11y({ speak: $('a11ySpeak').checked, care: false });
  $('a11yLarge').onchange = () => setA11y({ large: $('a11yLarge').checked, care: false });
  $('a11yContrast').onchange = () => setA11y({ contrast: $('a11yContrast').checked, care: false });
  $('a11yCare').onchange = () => setA11y({ care: $('a11yCare').checked });
  $('emSave').onclick = saveEmergency;
  $('emMode').onchange = () => { saveJson(EM_MODE_KEY, $('emMode').checked); toast($('emMode').checked ? tr('a11y.on') : ''); };
  $('emViewClose').onclick = closeEmCard;
  $('waitSend').onclick = sendWait;
  $('waitClose').onclick = closeWait;
  $('metSave').onclick = saveMet;
  $('metClose').onclick = closeMet;
  $('askYes').onclick = () => closeAsk(true);
  $('askNo').onclick = () => closeAsk(false);
  $('memImgClose').onclick = () => { $('memImgSheet').classList.add('hidden'); };
  if ($('meetSaveImg')) $('meetSaveImg').onclick = () => {
    const m = { id: $('meetCard').dataset.pid, name: $('meetCard').dataset.name, mine: (ctx.cfg && ctx.cfg.name) || tr('meet.you'), at: Date.now() };
    shareOrSaveMemory(m);
  };
  if ($('metShareImg')) $('metShareImg').onclick = () => {
    const m = { id: $('metSheet').dataset.pid, name: $('metSheet').dataset.name, mine: (ctx.cfg && ctx.cfg.name) || tr('meet.you'), at: Date.now() };
    shareOrSaveMemory(m);
  };
  window.addEventListener('langchange', () => {
    applyI18n($('tutSheet'));
    if (!$('tutSheet').classList.contains('hidden')) renderTut();
  });
  applyI18n(document);
  return {
    openTutorial, closeTutorial, refreshSafety, refreshWaiting, fillEmergency, applyRecognize,
    tickHud, speakName, maybeRememberMeet, setEvents, syncV34Ui, applyA11y, emergencyModeOn,
    saveSafetyFrames, openWaitForm, openMetNote, openEmCard, shareOrSaveMemory, metLineFor,
  };
}
