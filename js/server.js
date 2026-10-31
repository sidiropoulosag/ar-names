import { t, has as hasKey, getLang } from './i18n.js';
// "Family server" mode: API client, settings (localStorage) and Greek messages.
// The family server below is used by default; change it here (one place). Users can change it or clear it
// (= on-device only) in Settings.
export const DEFAULT_SERVER_URL = 'https://arnames.taila38131.ts.net';
const KEY = 'ar-names-server';

// Stored settings: 'serverUrl' exists ONLY if the user edited the address ('' = server switched off).
// No 'serverUrl' -> DEFAULT_SERVER_URL. Older versions stored 'url': a non-empty one counts as the user's choice.
export function loadCfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { c = {}; }
  let custom = null;
  if (typeof c.serverUrl === 'string') custom = c.serverUrl;
  else if (typeof c.url === 'string' && c.url.trim()) custom = c.url;
  return {
    token: c.token || '', enabled: !!c.enabled, personId: c.personId ?? null, name: c.name || '',
    customUrl: custom, url: custom === null ? DEFAULT_SERVER_URL : normUrl(custom),
  };
}
export function saveCfg(c) {
  const o = { token: c.token, enabled: c.enabled, personId: c.personId, name: c.name };
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
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    let r;
    try {
      r = await fetch(this.url + path, { method, headers, body, mode: 'cors', credentials: 'omit', cache: 'no-store', signal: ctl.signal });
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
  }
  health(timeout = 6000) { return this.req('GET', '/health', { auth: false, timeout }); }
  me() { return this.req('GET', '/people/me'); }
  people() { return this.req('GET', '/people'); }
  peoplePublic() { return this.req('GET', '/people/public', { auth: false, timeout: 6000 }); }   // ARN_PUBLIC_LIST=1 servers
  createPerson(familyKey, name, message, visibility) {
    const f = new FormData(); f.append('name', name); f.append('message', message || ''); f.append('visibility', visibility);
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
  createGroup(name) { return this.req('POST', '/groups', { json: { name } }); }
  joinGroup(gid) { return this.req('POST', `/groups/${gid}/join`); }
  leaveGroup(gid) { return this.req('POST', `/groups/${gid}/leave`); }
  // 0.6.0 pings: a reaction / short text to someone you can see; received ones (marked delivered)
  sendPing(pid, kind, content) { return this.req('POST', `/people/${pid}/pings`, { json: { kind, content }, timeout: 8000 }); }
  pings() { return this.req('GET', '/me/pings', { timeout: 5000 }); }
  recognize(faces) { return this.req('POST', '/recognize/embeddings', { json: { faces }, timeout: 5000 }); }
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
