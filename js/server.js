import { t, has as hasKey, getLang } from './i18n.js';
// "Family server" mode: API client, settings (localStorage) and Greek messages.
// The family server below is used by default; change it here (one place). Users can change it or clear it
// (= on-device only) in Settings.
export const DEFAULT_SERVER_URL = 'https://5-222-26-155.sslip.io';
export const FALLBACK_SERVER_URL = 'https://arnames.taila38131.ts.net';
const KEY = 'ar-names-server';
const FALLBACK_MS = 5 * 60 * 1000;
let fallbackUntil = 0;   // session-only: after a failed default, use the old server for a few minutes

// Stored settings: 'serverUrl' exists ONLY if the user edited the address ('' = server switched off).
// No 'serverUrl' -> DEFAULT_SERVER_URL. Older versions stored 'url': a non-empty one counts as the user's choice.
// A saved copy of the previous built-in default (Tailscale) is treated as "no custom URL" and moved to the new default.
export function canonUrl(u) {
  u = normUrl(u);
  if (!u) return '';
  try {
    const x = new URL(u);
    x.hostname = x.hostname.toLowerCase();
    const path = x.pathname === '/' ? '' : x.pathname.replace(/\/+$/, '');
    return x.protocol + '//' + x.hostname + (x.port ? ':' + x.port : '') + path + x.search;
  } catch (e) { return u.toLowerCase(); }
}
export function isLegacyDefaultUrl(u) { return canonUrl(u) === canonUrl(FALLBACK_SERVER_URL); }
function canFallback(cfg) { return cfg && cfg.customUrl === null && canonUrl(cfg.url) === canonUrl(DEFAULT_SERVER_URL); }
export function loadCfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { c = {}; }
  let custom = null;
  if (typeof c.serverUrl === 'string') custom = c.serverUrl;
  else if (typeof c.url === 'string' && c.url.trim()) custom = c.url;
  let migrated = false;
  if (custom !== null && custom !== '' && isLegacyDefaultUrl(custom)) { custom = null; migrated = true; }
  const cfg = {
    token: c.token || '', enabled: !!c.enabled, personId: c.personId ?? null, name: c.name || '',
    // v37: the linked sign-in account { provider, email } and a «signed in, no profile yet» ticket
    account: c.account && typeof c.account === 'object' ? c.account : null, ticket: c.ticket || '', pendingEmail: c.pendingEmail || '',
    customUrl: custom, url: custom === null ? DEFAULT_SERVER_URL : normUrl(custom),
  };
  if (migrated) saveCfg(cfg);
  return cfg;
}
export function saveCfg(c) {
  const o = { token: c.token, enabled: c.enabled, personId: c.personId, name: c.name };
  if (c.account) o.account = c.account;
  if (c.ticket) { o.ticket = c.ticket; o.pendingEmail = c.pendingEmail || ''; }
  if (c.customUrl !== null && c.customUrl !== undefined) o.serverUrl = c.customUrl;
  localStorage.setItem(KEY, JSON.stringify(o));
}
// User edited the address field: '' = off, anything else = custom address.
export function setUserUrl(c, raw) { c.customUrl = normUrl(raw); c.url = c.customUrl; }
// Back to the built-in default (forget the user's choice).
export function resetUrl(c) { c.customUrl = null; c.url = DEFAULT_SERVER_URL; }
export const isDefaultUrl = (c) => c.customUrl === null;
export function normUrl(u) {
  u = (u || '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

// v27: texts come from i18n.js (pose.* / err.*). The names stay for compatibility (posesEl / errEl = "in the app's language").
export const POSES = ['front', 'left', 'right', 'up', 'down', 'profile_left', 'profile_right'];
export const posesEl = (list) => (list || []).map((p) => (POSES.includes(p) ? t('pose.' + p) : p)).join(', ');
const GREEK = /[\u0370-\u03ff\u1f00-\u1fff]/;
// Server error -> words in the current language. Known codes are translated here (the server is never changed);
// unknown ones: HTTP status or the server's own text (unless it is Greek and the app is not).
export function errEl(e) {
  const code = e && e.code;
  if (code && hasKey('err.' + code)) return t('err.' + code);
  const m = /^http_(\d{3})$/.exec(code || '');
  const msg = e && e.message && e.message !== code ? String(e.message) : '';
  if (m) return t('err.http', { status: m[1] });
  if (msg && !(GREEK.test(msg) && getLang() !== 'el')) return msg;
  return t('err.unknown');
}

export class ApiError extends Error {
  constructor(status, code, message, detail) { super(message || code); this.status = status; this.code = code; this.detail = detail; }
}

export class Api {
  constructor(cfg) { this.cfg = cfg; }
  get url() { return normUrl(this.cfg.url); }
  async req(method, path, { json, form, familyKey, auth = true, timeout = 10000 } = {}) {
    if (!this.url) throw new ApiError(0, 'offline', 'no server url');
    const headers = {};
    if (auth && this.cfg.token) headers.Authorization = 'Bearer ' + this.cfg.token;
    if (familyKey) headers['X-Family-Key'] = familyKey;
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    else if (form) body = form;
    const go = async (base) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      let r;
      try {
        r = await fetch(base + path, { method, headers, body, mode: 'cors', credentials: 'omit', cache: 'no-store', signal: ctl.signal });
      } catch (e) {
        throw new ApiError(0, e.name === 'AbortError' ? 'timeout' : 'offline', String(e && e.message || e));
      } finally { clearTimeout(timer); }
      let data = null;
      try { data = await r.json(); } catch (e) { data = null; }
      if (!r.ok) {
        const d = data && data.detail;
        if (d && typeof d === 'object' && !Array.isArray(d)) throw new ApiError(r.status, d.code, d.message, d);
        throw new ApiError(r.status, r.status === 422 ? 'validation' : 'http_' + r.status, typeof d === 'string' ? d : 'HTTP ' + r.status, d);
      }
      return data;
    };
    // If the built-in default is unreachable, retry the previous (Tailscale) server. Custom URLs are never redirected.
    // After a miss, keep using the fallback for a few minutes so later calls are not delayed; then try the default again.
    const primary = this.url;
    const preferFb = canFallback(this.cfg) && Date.now() < fallbackUntil;
    const first = preferFb ? FALLBACK_SERVER_URL : primary;
    const second = preferFb ? primary
      : (canFallback(this.cfg) && canonUrl(primary) === canonUrl(DEFAULT_SERVER_URL) ? FALLBACK_SERVER_URL : null);
    try {
      const data = await go(first);
      if (canonUrl(first) === canonUrl(DEFAULT_SERVER_URL)) fallbackUntil = 0;
      return data;
    } catch (e) {
      const net = e && (e.code === 'offline' || e.code === 'timeout');
      if (net && second) {
        fallbackUntil = (canonUrl(second) === canonUrl(FALLBACK_SERVER_URL)) ? Date.now() + FALLBACK_MS : 0;
        return await go(second);
      }
      throw e;
    }
  }
  health(timeout = 6000) { return this.req('GET', '/health', { auth: false, timeout }); }
  me() { return this.req('GET', '/people/me'); }
  people() { return this.req('GET', '/people'); }
  peoplePublic() { return this.req('GET', '/people/public', { auth: false, timeout: 6000 }); }   // ARN_PUBLIC_LIST=1 servers
  // v32 (server 0.7.0): + consent, invite code, device id. Older servers ignore the extra form fields.
  createPerson(familyKey, name, message, visibility, extra = {}) {
    const f = new FormData(); f.append('name', name); f.append('message', message || ''); f.append('visibility', visibility);
    if (extra.consent) { f.append('consent', '1'); f.append('consent_version', extra.consentVersion || '1'); }
    if (extra.invite) f.append('invite', extra.invite);
    if (extra.deviceId) f.append('device_id', extra.deviceId);
    return this.req('POST', '/people', { form: f, familyKey, auth: false });
  }
  addFrame(pid, pose, blob) {
    const f = new FormData(); f.append('pose', pose); f.append('image', blob, 'frame.jpg');
    return this.req('POST', `/people/${pid}/frames`, { form: f, timeout: 30000 });
  }
  patchMe(pid, fields) { return this.req('PATCH', `/people/${pid}`, { json: fields }); }
  grant(pid, viewerId) { return this.req('POST', `/people/${pid}/grants`, { json: { viewer_id: viewerId } }); }
  revoke(pid, viewerId) { return this.req('DELETE', `/people/${pid}/grants/${viewerId}`); }
  deletePerson(pid) { return this.req('DELETE', `/people/${pid}`); }
  presence() { return this.req('POST', '/presence', { timeout: 6000 }); }   // 0.3.0+: 'I am online'
  // 0.5.0 groups
  searchGroups(q) { return this.req('GET', '/groups?q=' + encodeURIComponent(q), { timeout: 6000 }); }
  myGroups() { return this.req('GET', '/groups/mine', { timeout: 6000 }); }
  createGroup(name, kind = 'group') { return this.req('POST', '/groups', { json: { name, kind } }); }
  joinGroup(gid) { return this.req('POST', `/groups/${gid}/join`); }
  joinByCode(code) { return this.req('POST', '/groups/join', { json: { code } }); }
  groupCode(gid) { return this.req('POST', `/groups/${gid}/code`); }
  leaderboard(gid) { return this.req('GET', `/groups/${gid}/leaderboard`, { timeout: 6000 }); }
  leaveGroup(gid) { return this.req('POST', `/groups/${gid}/leave`); }
  // 0.6.0 pings: a reaction / short text to someone you can see; received ones (marked delivered)
  sendPing(pid, kind, content) { return this.req('POST', `/people/${pid}/pings`, { json: { kind, content }, timeout: 8000 }); }
  pings() { return this.req('GET', '/me/pings', { timeout: 5000 }); }
  // 0.7.0 privacy / safety
  deleteMe() { return this.req('DELETE', '/me', { timeout: 15000 }); }
  consent(version) { return this.req('POST', '/me/consent', { json: { version } }); }
  blocks() { return this.req('GET', '/me/blocks', { timeout: 6000 }); }
  block(pid) { return this.req('POST', `/people/${pid}/block`); }
  unblock(pid) { return this.req('DELETE', `/people/${pid}/block`); }
  report(pid, reason, note, block) { return this.req('POST', `/people/${pid}/report`, { json: { reason, note: note || '', block: !!block } }); }
  recognize(faces, extra = {}) {
    const body = { faces };
    if (extra && extra.emergency) body.emergency = true;   // only send when 0.9.0+ (caller checks hasCap)
    return this.req('POST', '/recognize/embeddings', { json: body, timeout: 5000 });
  }
  // 0.9.0 safety / emergency / waiting
  createSafety(body) { return this.req('POST', '/safety', { json: body }); }
  listSafety() { return this.req('GET', '/safety', { timeout: 8000 }); }
  addSafetyFrame(sid, pose, blob) {
    const f = new FormData(); f.append('pose', pose); f.append('image', blob, 'frame.jpg');
    return this.req('POST', `/safety/${sid}/frames`, { form: f, timeout: 30000 });
  }
  activateSafety(sid) { return this.req('POST', `/safety/${sid}/activate`); }
  foundSafety(sid) { return this.req('POST', `/safety/${sid}/found`); }
  sightSafety(sid, body) { return this.req('POST', `/safety/${sid}/sight`, { json: body, timeout: 8000 }); }
  reportSafety(sid, body) { return this.req('POST', `/safety/${sid}/report`, { json: body }); }
  sendWaiting(pid, body) { return this.req('POST', `/people/${pid}/waiting`, { json: body }); }
  myWaiting() { return this.req('GET', '/me/waiting', { timeout: 6000 }); }
  deleteWaiting(wid) { return this.req('DELETE', `/waiting/${wid}`); }
  // 0.10.0 sign-in (the device's token, if any, is sent so the server can link it)
  authGoogle(idToken, nonce, sw = false) { return this.req('POST', '/auth/google', { json: { id_token: idToken, nonce, switch: !!sw }, timeout: 15000 }); }
  emailStart(email) { return this.req('POST', '/auth/email/start', { json: { email }, timeout: 20000 }); }
  emailVerify(email, code, sw = false) { return this.req('POST', '/auth/email/verify', { json: { email, code, switch: !!sw }, timeout: 15000 }); }
  authLink(ticket) { return this.req('POST', '/auth/link', { json: { ticket } }); }
  myAccounts() { return this.req('GET', '/me/accounts', { timeout: 6000 }); }
  unlinkAccounts() { return this.req('DELETE', '/me/accounts'); }
  authLogout() { return this.req('POST', '/auth/logout', { timeout: 6000 }); }
}


// Same pose classes as the server (ar_server/face.py classify_pose), on the same 5-point pose estimate.
export function classifyPose(p) {
  if (!p) return 'front';
  const { yaw, pitch } = p;
  if (Math.abs(yaw) >= 45) return yaw > 0 ? 'profile_right' : 'profile_left';
  if (Math.abs(yaw) >= 15 && Math.abs(yaw) >= Math.abs(pitch)) return yaw > 0 ? 'right' : 'left';
  if (pitch <= -12) return 'up';
  if (pitch >= 15) return 'down';
  return 'front';
}
