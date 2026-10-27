// IndexedDB storage for enrolled people. Everything stays on this device.
const DB_NAME = 'ar-names', STORE = 'people';
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const st = t.objectStore(STORE);
    let out;
    Promise.resolve(fn(st)).then((v) => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function allPeople() {
  const db = await open();
  return req(db.transaction(STORE).objectStore(STORE).getAll());
}
export async function putPerson(p) { return tx('readwrite', (st) => { st.put(p); }); }
export async function deletePerson(id) { return tx('readwrite', (st) => { st.delete(id); }); }
export async function clearAll() { return tx('readwrite', (st) => { st.clear(); }); }

export function newId() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

export async function exportJSON() {
  const people = await allPeople();
  return JSON.stringify({
    app: 'ar-names', version: 1, model: 'sface_2021dec_int8', exported: new Date().toISOString(),
    people: people.map((p) => ({ ...p, embeddings: p.embeddings.map((e) => Array.from(e, (v) => Math.round(v * 1e5) / 1e5)) })),
  });
}
export async function importJSON(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.people)) throw new Error('Μη έγκυρο αρχείο');
  let n = 0;
  for (const p of data.people) {
    if (!p.name || !Array.isArray(p.embeddings)) continue;
    await putPerson({ id: p.id || newId(), name: String(p.name), thumb: p.thumb || '', created: p.created || Date.now(),
      embeddings: p.embeddings.map((e) => Float32Array.from(e)) });
    n++;
  }
  return n;
}

const SKEY = 'ar-names-settings';
export const defaults = { threshold: 0.40, margin: 0.05, showUnknown: true, maxFaces: 12, range: 512 };
export function loadSettings() {
  try {
    const s = { ...defaults, ...JSON.parse(localStorage.getItem(SKEY) || '{}') };
    delete s.showStats;   // v14: the «ταχύτητα (ms / fps)» option was removed; ignore it in old saved settings
    return s;
  } catch { return { ...defaults }; }
}
export function saveSettings(s) { localStorage.setItem(SKEY, JSON.stringify(s)); }
