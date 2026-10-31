import { t } from './i18n.js';
// v24 (server 0.6.0 'pings'): tap a recognised person -> send a reaction or a short text; received ones show
// as a floating card at the top. Pure helpers + the card queue (no server calls here).
export const PING_EMOJI = ['❤️', '👋', '👍', '😂', '🎉', '😮', '🙏', '🔥'];
export const PING_TEXT_MAX = 80;
export const CARD_MS = 5000;

// «Στείλε στον Γιάννη» / «Send to Alex» / «Envoyer à Léa» (the Greek accusative heuristic lives in i18n.js)
export function sendTitle(name) { return t('ping.sendTo', { name: String(name || '').trim() }); }

// one-at-a-time card queue; render(item, done) shows a card and calls done() when it is gone
export class CardQueue {
  constructor(show) { this.show = show; this.q = []; this.busy = false; this.shown = []; }
  push(item) { this.q.push(item); if (!this.busy) this.next(); }
  next() {
    const it = this.q.shift();
    if (!it) { this.busy = false; return; }
    this.busy = true; this.shown.push(it); if (this.shown.length > 50) this.shown.shift();
    // a long queue goes a bit faster (still readable)
    const ms = this.q.length >= 3 ? 3000 : CARD_MS;
    this.show(it, ms, () => this.next());
  }
}
