// v33: local collection / badges. No pressure — unlock quietly, celebrate once, store on this device.
import { t } from './i18n.js';

const KEY = 'ar-names-achievements';
const DAY_KEY = 'ar-names-ach-day';

export const BADGES = [
  { id: 'meet10',  icon: '👋', need: (s) => s.met >= 10,  key: 'ach.meet10' },
  { id: 'meet50',  icon: '🌟', need: (s) => s.met >= 50,  key: 'ach.meet50' },
  { id: 'greet5',  icon: '💌', need: (s) => s.greets >= 5, key: 'ach.greet5' },
  { id: 'greet25', icon: '🎉', need: (s) => s.greets >= 25, key: 'ach.greet25' },
  { id: 'variety', icon: '🌈', need: (s) => s.dayEmojis.size >= 5, key: 'ach.variety' },
  { id: 'event1',  icon: '🎫', need: (s) => s.events >= 1, key: 'ach.event1' },
  { id: 'filter1', icon: '👑', need: (s) => s.filters >= 1, key: 'ach.filter1' },
];

function load() {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      met: new Set(j.met || []),
      greets: +j.greets || 0,
      events: +j.events || 0,
      filters: +j.filters || 0,
      unlocked: new Set(j.unlocked || []),
      seen: new Set(j.seen || []),
      day: j.day || '',
      dayEmojis: new Set(j.dayEmojis || []),
    };
  } catch (_) {
    return { met: new Set(), greets: 0, events: 0, filters: 0, unlocked: new Set(), seen: new Set(), day: '', dayEmojis: new Set() };
  }
}

function save(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      met: [...s.met], greets: s.greets, events: s.events, filters: s.filters,
      unlocked: [...s.unlocked], seen: [...s.seen], day: s.day, dayEmojis: [...s.dayEmojis],
    }));
  } catch (_) {}
}

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function rollDay(s) {
  const d = today();
  if (s.day !== d) { s.day = d; s.dayEmojis = new Set(); }
}

let state = load();
const listeners = new Set();

function snap() {
  return { met: state.met.size, greets: state.greets, events: state.events, filters: state.filters, dayEmojis: state.dayEmojis };
}

function check() {
  const fresh = [];
  const sc = snap();
  for (const b of BADGES) {
    if (state.unlocked.has(b.id)) continue;
    if (b.need(sc)) { state.unlocked.add(b.id); fresh.push(b); }
  }
  if (fresh.length) save(state);
  for (const b of fresh) for (const fn of listeners) try { fn(b); } catch (_) {}
  return fresh;
}

export function onUnlock(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function noteMet(personId) {
  if (!personId) return [];
  const id = String(personId);
  if (state.met.has(id)) return [];
  state.met.add(id); save(state); return check();
}

export function noteGreet(emoji) {
  state.greets += 1;
  rollDay(state);
  if (emoji) state.dayEmojis.add(String(emoji));
  save(state); return check();
}

export function noteEvent() { state.events += 1; save(state); return check(); }
export function noteFilter() { state.filters += 1; save(state); return check(); }

export function list() {
  return BADGES.map((b) => ({
    id: b.id, icon: b.icon, title: t(b.key + '.t'), hint: t(b.key + '.h'),
    unlocked: state.unlocked.has(b.id), new: state.unlocked.has(b.id) && !state.seen.has(b.id),
  }));
}

export function markSeen(id) {
  if (!id) { for (const x of state.unlocked) state.seen.add(x); }
  else state.seen.add(id);
  save(state);
}

export function stats() {
  return { met: state.met.size, greets: state.greets, events: state.events, filters: state.filters, unlocked: state.unlocked.size };
}

export function resetForTests() {
  state = { met: new Set(), greets: 0, events: 0, filters: 0, unlocked: new Set(), seen: new Set(), day: '', dayEmojis: new Set() };
  try { localStorage.removeItem(KEY); localStorage.removeItem(DAY_KEY); } catch (_) {}
}

export const achievements = { noteMet, noteGreet, noteEvent, noteFilter, list, markSeen, stats, onUnlock, BADGES, KEY, resetForTests };
