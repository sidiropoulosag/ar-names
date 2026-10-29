// v24 (server 0.6.0 'pings'): tap a recognised person -> send a reaction or a short text; received ones show
// as a floating card at the top. Pure helpers + the card queue (no server calls here).
export const PING_EMOJI = ['❤️', '👋', '👍', '😂', '🎉', '😮', '🙏', '🔥'];
export const PING_TEXT_MAX = 80;
export const CARD_MS = 5000;

// «Στείλε στον Γιάννη» / «Στείλε στην Μαρία» / «Στείλε στον/στην Alex» (simple Greek accusative heuristic)
export function sendTitle(name) {
  const n = String(name || '').trim();
  const parts = n.split(/\s+/), first = parts[0] || '';
  const low = first.toLocaleLowerCase('el');
  if (/[\u0370-\u03ff\u1f00-\u1fff]/.test(first)) {
    if (/[οηα][ςσ]$|[όήά][ςσ]$/.test(low) && first.length > 2) return 'Στείλε στον ' + [first.slice(0, -1), ...parts.slice(1)].join(' ');
    if (/[αηωάήώ]$/.test(low)) return 'Στείλε στην ' + n;
  }
  return 'Στείλε στον/στην ' + n;
}

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
