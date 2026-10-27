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

export const POSE_EL = {
  front: 'ευθεία', left: 'στραμμένο αριστερά', right: 'στραμμένο δεξιά', up: 'πηγούνι πάνω', down: 'πηγούνι κάτω',
  profile_left: 'προφίλ (αριστερά)', profile_right: 'προφίλ (δεξιά)',
};
export const posesEl = (list) => (list || []).map((p) => POSE_EL[p] || p).join(', ');

const CODE_EL = {
  no_face: 'δεν βρέθηκε καθαρό πρόσωπο',
  multiple_faces: 'φαίνονται πολλά πρόσωπα — μόνο εσύ στο κάδρο',
  face_too_small: 'το πρόσωπο είναι πολύ μικρό — έλα πιο κοντά',
  blurry: 'θολή λήψη — κράτα σταθερά το κινητό',
  bad_lighting: 'πολύ σκοτεινό ή πολύ φωτεινό',
  pose_mismatch: 'η γωνία δεν ταιριάζει',
  duplicate: 'σχεδόν ίδια με προηγούμενη λήψη (δεν χρειάζεται)',
  different_person: 'δεν μοιάζει με τις προηγούμενες λήψεις σου',
  bad_pose: 'άγνωστη γωνία',
  too_many_frames: 'έφτασες το μέγιστο αριθμό λήψεων',
  too_large: 'η εικόνα είναι πολύ μεγάλη',
  bad_image: 'μη έγκυρη εικόνα',
  family_key_required: 'λάθος κλειδί πρόσβασης',
  server_full: 'ο server έφτασε το μέγιστο αριθμό ατόμων — μίλα με τον διαχειριστή',
  too_many_enrollments: 'πάρα πολλές νέες εγγραφές από αυτό το δίκτυο — δοκίμασε σε λίγο',
  too_many_attempts: 'πολλές λάθος προσπάθειες κλειδιού — δοκίμασε αργότερα',
  auth_required: 'λείπει το token σου',
  bad_token: 'το token δεν ισχύει (ίσως άλλαξε ή διαγράφηκε το προφίλ)',
  not_found: 'δεν βρέθηκε',
  not_owner: 'δεν επιτρέπεται',
  self_grant: 'βλέπεις πάντα το δικό σου μήνυμα',
  viewer_not_found: 'το άτομο δεν βρέθηκε',
  offline: 'δεν υπάρχει σύνδεση τώρα',
  timeout: 'ο server άργησε να απαντήσει',
  validation: 'μη έγκυρα στοιχεία',
};
export function errEl(e) {
  return CODE_EL[e && e.code] || (e && e.message) || 'άγνωστο σφάλμα';
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
