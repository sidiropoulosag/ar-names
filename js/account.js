// v37: «Λογαριασμός» — sign in with Google (main) or with an email code (alternative), server 0.10.0+.
// The profile (name, messages, groups and the face enrolment) already lives on the server; signing in links it to
// a verified Google / email identity. On a new phone or after a reinstall the same sign-in gives this device its own
// token for that profile, so everything comes back WITHOUT new photos. Nothing changes for people who never sign in.
//
// Google uses the plain OAuth redirect (no Google script: the page is cross-origin isolated, COEP require-corp):
// accounts.google.com → back to this page with #id_token=… → the server checks the token with Google's keys.
// The client id comes from the server (/health → auth.google_client_id); no id = no Google button.
import { t as tr } from './i18n.js';

const $ = (id) => document.getElementById(id);
const G_KEY = 'noera-google-auth';   // { state, nonce, at } while we are away at Google
const HINT_KEY = 'noera-acc-hint';   // the one gentle «sign in so you don't lose your profile» note was shown
let ctx = null;
let pendingGoogle = null;            // { idToken, nonce } back from Google, not yet sent to the server
let emailAddr = '';

function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch (_) {} }
function rnd() { const a = new Uint8Array(16); crypto.getRandomValues(a); return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join(''); }

// v44: Google's answer is also kept in this tab's sessionStorage until the server has answered, so a reload in
// between (an app update, the first-visit service-worker reload) continues the sign-in instead of losing it.
const PEND_KEY = 'noera-google-pending';
function ssGet() { try { return JSON.parse(sessionStorage.getItem(PEND_KEY) || 'null'); } catch (_) { return null; } }
function ssSet(v) { try { sessionStorage.setItem(PEND_KEY, JSON.stringify(v)); } catch (_) {} }
function ssDel() { try { sessionStorage.removeItem(PEND_KEY); } catch (_) {} }

// Read the Google answer from the address bar as early as possible (module load) and clean the address.
(function captureRedirect() {
  try {
    const h = location.hash || '';
    if (!/(^#|&)(id_token|error)=/.test(h)) {
      const s = ssGet();   // a reload after the address was already cleaned
      if (s && s.idToken && Date.now() - s.at < 10 * 60 * 1000) pendingGoogle = { idToken: s.idToken, nonce: s.nonce };
      else if (s) ssDel();
      return;
    }
    const p = new URLSearchParams(h.slice(1));
    if (!p.has('state')) return;
    history.replaceState(null, '', location.pathname + location.search);
    let saved = null; try { saved = JSON.parse(lsGet(G_KEY) || 'null'); } catch (_) {}
    lsDel(G_KEY);
    if (!saved || saved.state !== p.get('state') || Date.now() - saved.at > 15 * 60 * 1000) { pendingGoogle = { error: 'state' }; return; }
    if (p.get('id_token')) { pendingGoogle = { idToken: p.get('id_token'), nonce: saved.nonce }; ssSet({ ...pendingGoogle, at: Date.now() }); }
    else pendingGoogle = { error: p.get('error') || 'error' };
  } catch (_) {}
})();

let googleBusy = false;   // v44: Google's answer is being sent to the server
export const hasPendingSignIn = () => !!pendingGoogle || googleBusy;

function health() { return ctx.health() || null; }
function auth() { const h = health(); return (h && h.auth) || {}; }
function supported() { return !!(ctx.cfg.url && ctx.hasCap('accounts')); }
function googleOn() { return supported() && !!auth().google_client_id; }
function emailOn() { return supported() && !!auth().email; }
export function available() { return googleOn() || emailOn(); }

function msg(text, ok) {
  for (const id of ['accMsg', 'gateMsg']) {   // v44: the start sign-in screen (gate) has its own message line
    const m = $(id); if (!m) continue;
    m.textContent = text || ''; m.classList.toggle('ok', !!ok);
  }
}
const gateOn = () => !!(ctx && ctx.gate && ctx.gate.active());
function provName(p) { return p === 'google' ? 'Google' : tr('acc.provEmail'); }

export function render() {
  if (!ctx || !$('accPage')) return;
  const c = ctx.cfg, on = available(), acc = c.account;
  $('accOff').classList.toggle('hidden', on);
  $('accOff').textContent = !c.url ? tr('acc.offLocal') : (health() && !ctx.hasCap('accounts')) ? tr('acc.offOld') : tr('acc.offNotYet');
  $('accIn').classList.toggle('hidden', !(on && acc && c.token));
  $('accOut').classList.toggle('hidden', !on || !!(acc && c.token));
  if (acc && c.token) $('accWho').textContent = tr('acc.signedAs', { email: acc.email || '—', prov: provName(acc.provider) });
  $('accLead').textContent = tr(c.token ? 'acc.leadHave' : 'acc.leadNew');
  $('accGoogle').classList.toggle('hidden', !googleOn());
  $('accEmailBox').classList.toggle('hidden', !emailOn());
  $('accOr').classList.toggle('hidden', !(googleOn() && emailOn()));
  for (const id of ['startSignIn', 'enSignIn']) { const b = $(id); if (b) b.classList.toggle('hidden', !on || !!c.token); }
}

// Opening the page: ask the server which accounts are linked (another phone may have changed it).
export async function refresh() {
  if (!ctx) return;
  if (!health() && ctx.cfg.url) { try { await ctx.loadHealth(); } catch (_) {} }
  render();
  if (ctx.cfg.token && supported()) {
    try { const r = await ctx.api.myAccounts(); setAccount((r.accounts || [])[0] || null); } catch (_) {}
    render();
  }
}
function setAccount(a) { ctx.cfg.account = a ? { provider: a.provider, email: a.email || '' } : null; ctx.saveCfg(); }
// /people/me (0.10.0) carries the linked accounts
export function noteMe(me) { if (me && Array.isArray(me.accounts)) { setAccount(me.accounts[0] || null); render(); } }

// Official OAuth redirect URI is https://sidiropoulosag.github.io/ar-names/ (must match exactly).
// Normalise /ar-names, /ar-names/ and /ar-names/index.html to the directory URL.
function googleRedirectUri() {
  const u = new URL(location.href);
  let path = u.pathname;
  if (path.endsWith('index.html')) path = path.slice(0, -'index.html'.length);
  if (!path.endsWith('/')) path += '/';
  return u.origin + path;
}

function startGoogle() {
  const id = auth().google_client_id; if (!id) return;
  const state = rnd(), nonce = rnd();
  lsSet(G_KEY, JSON.stringify({ state, nonce, at: Date.now() }));
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: id, redirect_uri: googleRedirectUri(), response_type: 'id_token',
    scope: 'openid email profile', nonce, state, prompt: 'select_account',
  }).toString();
  msg(tr('acc.toGoogle'));
  location.assign(u.href);
}

// The server's answer to a sign-in (Google or email) — same handling for both.
async function finish(r) {
  if (gateOn()) {   // v44: the sign-in screen at the start: same server calls, the screen decides what comes next
    if (r.status === 'restored') { setAccount(r.account); await ctx.onRestored(r.person, r.token); }
    else if (r.status === 'linked' || r.status === 'already') setAccount(r.account);
    else if (r.status === 'no_profile') { ctx.cfg.ticket = r.ticket || ''; setAccount(null); ctx.cfg.pendingEmail = (r.account && r.account.email) || ''; ctx.saveCfg(); }
    render(); ctx.gate.onResult(r); return;
  }
  if (r.status === 'restored') {
    setAccount(r.account);
    await ctx.onRestored(r.person, r.token);
    const ready = r.person && r.person.enrollment && r.person.enrollment.active;
    const t = tr(ready ? 'acc.restored' : 'acc.restoredMore', { name: r.person ? r.person.name : '' });
    msg(t, true); ctx.toast(tr('acc.restoredToast'));
  } else if (r.status === 'linked' || r.status === 'already') {
    setAccount(r.account); msg(tr('acc.linked'), true); ctx.toast(tr('acc.linked'));
  } else if (r.status === 'no_profile') {
    ctx.cfg.ticket = r.ticket || ''; setAccount(null); ctx.cfg.pendingEmail = (r.account && r.account.email) || ''; ctx.saveCfg();
    const t = tr('acc.noProfile', { email: ctx.cfg.pendingEmail ? ` (${ctx.cfg.pendingEmail})` : '' });
    msg(t, true); ctx.offerEnroll(t);
  }
  render();
}

async function withSwitch(call, e) {
  if (!(e && e.code === 'account_other_profile')) throw e;
  const name = (e.detail && e.detail.name) || '';
  if (!confirm(tr('acc.switchQ', { name, mine: ctx.cfg.name || '' }))) { msg(tr('acc.switchNo')); return null; }
  return await call(true);
}

async function completeGoogle() {
  googleBusy = true;
  try { await completeGoogle1(); } finally { googleBusy = false; }
}
async function completeGoogle1() {
  const p = pendingGoogle; pendingGoogle = null;
  if (!p) return;
  if (p.error) {
    if (p.error !== 'access_denied') { ctx.toast(tr('acc.googleFail')); if (gateOn()) msg(tr('acc.googleFail')); }
    else if (gateOn()) msg(tr('gate.cancelled'));
    if (gateOn()) ctx.gate.onFail(false);
    return;
  }
  if (!health()) { try { await ctx.loadHealth(); } catch (_) {} }
  const call = (sw) => ctx.api.authGoogle(p.idToken, p.nonce, sw);
  try {
    let r; try { r = await call(false); } catch (e) { r = await withSwitch(call, e); }
    ssDel();
    if (r) await finish(r); else if (gateOn()) ctx.gate.onFail(false);
  } catch (e) {
    if (e && (e.code === 'offline' || e.code === 'timeout')) pendingGoogle = p;   // v44: keep Google's answer so «Δοκίμασε ξανά» can send it again
    else ssDel();
    const m = e.code === 'google_bad_token' ? tr('acc.googleFail') : ctx.errMsg(e);
    ctx.toast('⚠️ ' + m); if (gateOn()) { msg('⚠️ ' + m); ctx.gate.onFail(!!pendingGoogle); }
  }
}

async function sendCode() {
  const email = ($('accEmail').value || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) { msg(tr('acc.badEmail')); $('accEmail').focus(); return; }
  $('accSend').disabled = true; msg(tr('acc.sending'));
  try {
    await ctx.api.emailStart(email);
    emailAddr = email;
    $('accCodeBox').classList.remove('hidden'); $('accCode').value = ''; $('accCode').focus();
    msg(tr('acc.codeSent', { email }), true);
  } catch (e) {
    msg('⚠️ ' + (e.code === 'too_soon' ? tr('acc.tooSoon') : e.code === 'too_many' ? tr('acc.tooMany') : ctx.errMsg(e)));
  } finally { $('accSend').disabled = false; }
}

async function verifyCode() {
  const code = ($('accCode').value || '').replace(/\D/g, '');
  if (code.length < 6) { msg(tr('acc.codeShort')); $('accCode').focus(); return; }
  $('accVerify').disabled = true;
  const call = (sw) => ctx.api.emailVerify(emailAddr, code, sw);
  try {
    let r; try { r = await call(false); } catch (e) { r = await withSwitch(call, e); }
    if (r) { $('accCodeBox').classList.add('hidden'); await finish(r); }
  } catch (e) {
    msg('⚠️ ' + (e.code === 'code_wrong' ? tr('acc.codeWrong') : e.code === 'code_expired' ? tr('acc.codeExpired') : ctx.errMsg(e)));
  } finally { $('accVerify').disabled = false; }
}

async function unlink() {
  if (!confirm(tr('acc.unlinkQ'))) return;
  try { await ctx.api.unlinkAccounts(); setAccount(null); msg(tr('acc.unlinked'), true); }
  catch (e) { msg('⚠️ ' + ctx.errMsg(e)); }
  render();
}

// After a new profile was made on this device: link the account the user signed in with first.
export async function linkAfterEnroll() {
  const c = ctx.cfg;
  if (!c.ticket || !c.token) return;
  try {
    const r = await ctx.api.authLink(c.ticket);
    setAccount((r.accounts || [])[0] || null); ctx.toast(tr('acc.linked'));
  } catch (e) { console.warn('account link', e); }
  c.ticket = ''; c.pendingEmail = ''; ctx.saveCfg(); render();
}

// «Αποσύνδεση» on this device: the token this phone got at sign-in stops working on the server too.
export function signOutDevice() {
  if (ctx && ctx.cfg.token && supported()) ctx.api.authLogout().catch(() => {});
  if (ctx) { ctx.cfg.account = null; ctx.cfg.ticket = ''; }
}

// One gentle note (once per phone) for people who have a profile but never signed in.
export function maybeHint() {
  if (!ctx || !ctx.cfg.token || ctx.cfg.account || !available() || lsGet(HINT_KEY)) return;
  lsSet(HINT_KEY, '1');
  setTimeout(() => ctx.toast(tr('acc.hint')), 2500);
}

// v44: pieces the start sign-in screen (js/gate.js) uses — the very same flows as «Λογαριασμός»
export const signInWithGoogle = () => startGoogle();
export async function verifyEmailCodeFor(email, code) {   // throws the server error; true = the server accepted the code
  const call = (sw) => ctx.api.emailVerify(email, code, sw);
  let r; try { r = await call(false); } catch (e) { r = await withSwitch(call, e); }
  if (r) { await finish(r); return true; }
  return false;
}
export function retryPendingGoogle() { if (!pendingGoogle || googleBusy) return false; completeGoogle(); return true; }

export function initAccount(c) {
  ctx = c;
  $('accGoogle').onclick = startGoogle;
  $('accSend').onclick = sendCode;
  $('accEmail').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); sendCode(); } };
  $('accVerify').onclick = verifyCode;
  $('accCode').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); verifyCode(); } };
  $('accResend').onclick = () => { $('accCodeBox').classList.add('hidden'); sendCode(); };
  $('accUnlink').onclick = unlink;
  render();
  if (pendingGoogle) completeGoogle();
  return { render, refresh, noteMe, linkAfterEnroll, signOutDevice, maybeHint, available, hasPendingSignIn, setAccount, signInWithGoogle, verifyEmailCodeFor, retryPendingGoogle };
}
