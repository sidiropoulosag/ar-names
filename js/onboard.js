// v38: guided first-time setup, folded into the photo setup (no separate tour any more).
//   1) name + photos (the normal enrolment, with a small «Βήμα 1 από 4» guide on top)  — in main.js
//   2) the 3D object above the head      3) the text above the head      4) «Έτοιμο, χρησιμοποίησέ το»
// Only the basics. Every step can be skipped; «Αργότερα» leaves at any time (all of it can be changed later in
// Settings → «Το προφίλ μου» / «Εμφάνιση και ήχος»). Shown once per phone: people who already have a profile are never
// sent through it again (flag KEY); it can be reopened by hand from «Το προφίλ μου» or from Help.
import { t as tr } from './i18n.js';
import { OBJECTS, objectInfo, assetUrl } from './objects3d.js';

const $ = (id) => document.getElementById(id);
export const KEY = 'ar-names-setup-v38';
const ORDER = ['obj', 'msg', 'done'];
const CHIPS = ['su.c1', 'su.c2', 'su.c3', 'su.c4'];
const MSG_MAX = 80;

function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

export function initOnboard(ctx) {
  const st = { step: 'obj', obj: '', msg: '', pick: 'object3d', pickUser: false, shown: false };

  const isDone = () => lsGet(KEY) === '1';
  const markDone = () => lsSet(KEY, '1');

  // grid of 3D objects (thumbnails load lazily; same registry as Settings)
  function buildGrid() {
    const box = $('suObjs'); if (box.children.length) return;
    for (const o of OBJECTS) {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.obj = o.id; b.setAttribute('role', 'radio');
      if (o.thumb) { const im = new Image(); im.loading = 'lazy'; im.decoding = 'async'; im.alt = ''; im.width = im.height = 56; im.src = assetUrl(o.thumb); b.appendChild(im); }
      else { const e = document.createElement('span'); e.className = 'emo'; e.textContent = o.emoji; b.appendChild(e); }
      const s = document.createElement('span'); s.dataset.i18n = 'obj.' + o.id; s.textContent = o.name; b.appendChild(s);
      b.onclick = () => { st.obj = o.id; paint(); };
      box.appendChild(b);
    }
  }

  function objLabel() { return st.obj ? objectInfo(st.obj).name : ''; }

  function paint() {
    const i = ORDER.indexOf(st.step);
    for (const sec of document.querySelectorAll('#setup .wstep')) sec.classList.toggle('on', sec.dataset.step === st.step);
    [...document.querySelectorAll('#setup .wel-dots span')].forEach((d, k) => { d.classList.toggle('on', k === i + 1); d.classList.toggle('past', k <= i); });
    $('setup').querySelector('.wel-dots').setAttribute('aria-label', tr('su.step', { i: i + 2, n: 4 }));
    for (const b of $('suObjs').children) { const on = b.dataset.obj === st.obj; b.classList.toggle('sel', on); b.setAttribute('aria-checked', String(on)); }
    $('suBack').classList.toggle('off', i === 0);
    const last = st.step === 'done';
    const can = st.step === 'obj' ? !!st.obj : st.step === 'msg' ? !!st.msg.trim() : true;
    $('suNext').classList.toggle('hidden', last); $('suNext').disabled = !can;
    $('suSkip').classList.toggle('hidden', last);
    $('suDone').classList.toggle('hidden', !last);
    $('suStepTag').textContent = tr('su.step', { i: i + 2, n: 4 });
    if (last) paintDone();
  }

  function paintDone() {
    const name = ctx.cfg.name || '';
    $('suDoneTitle').textContent = name ? tr('su.doneT', { name }) : tr('su.doneT0');
    const lines = [];
    if (st.obj) lines.push(['🧸', tr('su.sumObj', { obj: objLabel() })]);
    if (st.msg.trim()) lines.push(['💬', tr('su.sumMsg', { msg: st.msg.trim() })]);
    if (!lines.length) lines.push(['🏷️', tr('su.sumNone')]);
    const ul = $('suSummary'); ul.textContent = '';
    for (const [ico, text] of lines) {
      const li = document.createElement('li'); const a = document.createElement('span'); a.className = 'wli'; a.setAttribute('aria-hidden', 'true'); a.textContent = ico;
      const b = document.createElement('span'); b.textContent = text; li.append(a, b); ul.appendChild(li);
    }
    const both = !!st.obj && !!st.msg.trim() && ctx.hasCap('combo');
    const triple = both && ctx.hasCap('combo3');
    $('suPick').classList.toggle('hidden', !both);
    $('suPickBoth').classList.toggle('hidden', !triple);
    if (triple && !st.pickUser) st.pick = 'both';
    if (!triple && st.pick === 'both') st.pick = 'object3d';
    for (const r of document.querySelectorAll('#suPick input')) r.checked = r.value === st.pick;
  }

  function go(step) { st.step = step; paint(); const b = $('setup').querySelector('.wel-body'); if (b) b.scrollTop = 0; }
  const next = () => { const i = ORDER.indexOf(st.step); if (i < ORDER.length - 1) go(ORDER[i + 1]); };

  function open(opts = {}) {
    buildGrid();
    st.obj = ''; st.msg = ''; st.pick = 'object3d'; st.pickUser = false;
    if (opts.prefill && ctx.prefill) { const p = ctx.prefill(); st.obj = p.obj || ''; st.msg = p.msg || ''; }
    $('suMsg').value = st.msg;
    markDone(); st.shown = true;
    $('setup').classList.remove('hidden'); document.body.classList.add('wel-on');
    go('obj');
    setTimeout(() => { try { $('suNext').focus({ preventScroll: true }); } catch (_) {} }, 50);
  }
  function close() {
    st.shown = false;
    $('setup').classList.add('hidden'); document.body.classList.remove('wel-on');
  }

  async function finish() {
    const c = ctx.cfg, text = st.msg.trim();
    $('suDone').disabled = true;
    try {
      if (c.token && (st.obj || text)) {
        const f = {};
        if (st.obj) f.object_id = st.obj;
        if (text) f.message = text;
        if (ctx.hasCap('combo')) {
          if (st.pick === 'both' && st.obj && text && ctx.hasCap('combo3')) {
            f.display_items = ['name', 'object3d', 'message1'];
          } else {
            const useObj = st.obj && (!text || st.pick === 'object3d');
            f.display_items = ['name', useObj ? 'object3d' : 'message1'];
          }
        } else f.display_mode = st.obj && (!text || st.pick === 'object3d') ? 'object3d' : 'message';
        if (c.personId == null) { const me = await ctx.api.me(); c.personId = me.id; c.name = me.name; ctx.saveCfg(); }
        await ctx.api.patchMe(c.personId, f);
        if (text) ctx.rememberMsg(text);
      }
      close();
      await ctx.afterSave();
      ctx.toast(tr('su.readyToast'));
    } catch (e) {
      ctx.toast('⚠️ ' + ctx.errMsg(e));
    } finally { $('suDone').disabled = false; }
  }

  $('suNext').onclick = next;
  $('suSkip').onclick = () => { if (st.step === 'obj') st.obj = ''; if (st.step === 'msg') { st.msg = ''; $('suMsg').value = ''; } next(); };
  $('suBack').onclick = () => { const i = ORDER.indexOf(st.step); if (i > 0) go(ORDER[i - 1]); };
  $('suLater').onclick = () => { close(); ctx.afterSave(); };
  $('suDone').onclick = finish;
  $('suMsg').oninput = () => { st.msg = $('suMsg').value.slice(0, MSG_MAX); paint(); };
  for (const r of document.querySelectorAll('#suPick input')) r.onchange = () => { if (r.checked) { st.pick = r.value; st.pickUser = true; } };
  const chips = $('suChips');
  for (const k of CHIPS) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'su-chip'; b.dataset.i18n = k; b.textContent = tr(k);
    b.onclick = () => { $('suMsg').value = tr(k); st.msg = tr(k); paint(); };
    chips.appendChild(b);
  }
  window.addEventListener('langchange', () => { if (st.shown) paint(); });
  return { open, close, isDone, markDone, get shown() { return st.shown; } };
}
