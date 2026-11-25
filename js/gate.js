// v44: «Σύνδεση στην αρχή» — the very first screen of the app. Nobody gets to the camera or the photo setup before
// signing in (Google = main way, email 6-digit code = alternative). It reuses the «Λογαριασμός» flows of js/account.js
// (same server calls, same Google redirect, same email codes) — this file is only the screen and the decision.
//   • already signed in on this device (token + linked account)  -> no screen at all
//   • the account has a profile (new phone / reinstall)           -> restored, straight to the camera
//   • the account is new                                          -> on into the 4-step setup (name, 3D, text, ready)
//   • a profile already on this device but no account yet (older users) -> signing in links it (nothing is lost)
//   • server unreachable                                          -> clear message + «Δοκίμασε ξανά»
//   • the server has no sign-in set up (or no server at all)      -> no screen: the old behaviour
import { t as tr, dict, applyI18n } from './i18n.js';

const $ = (id) => document.getElementById(id);

Object.assign(dict.el, {
  'gate.lead': 'Καλώς ήρθες στο Noera! Συνδέσου για να ξεκινήσεις.',
  'gate.why': 'Έτσι το προφίλ σου είναι δικό σου και επιστρέφει αν αλλάξεις κινητό — χωρίς νέες φωτογραφίες.',
  'gate.have': 'Έχεις ήδη προφίλ σε αυτό το κινητό: συνδέσου και θα δεθεί με τον λογαριασμό σου. Δεν χάνεις τίποτα.',
  'gate.email': '✉️ Σύνδεση με email',
  'gate.checking': 'Έλεγχος σύνδεσης…',
  'gate.finishing': 'Ολοκλήρωση σύνδεσης…',
  'gate.offline': 'Δεν μπορώ να συνδεθώ με τον server του Noera. Έλεγξε το ίντερνετ και δοκίμασε ξανά.',
  'gate.retry': '↻ Δοκίμασε ξανά',
  'gate.back': '‹ Πίσω',
  'gate.cancelled': 'Η σύνδεση ακυρώθηκε. Δοκίμασε ξανά όποτε θέλεις.',
  'gate.otherEmail': 'Άλλο email',
});
Object.assign(dict.en, {
  'gate.lead': 'Welcome to Noera! Sign in to get started.',
  'gate.why': 'This keeps your profile yours and brings it back if you change phone — with no new photos.',
  'gate.have': 'You already have a profile on this phone: sign in and it will be linked to your account. You lose nothing.',
  'gate.email': '✉️ Sign in with email',
  'gate.checking': 'Checking the connection…',
  'gate.finishing': 'Finishing the sign-in…',
  'gate.offline': 'I cannot reach the Noera server. Check your internet and try again.',
  'gate.retry': '↻ Try again',
  'gate.back': '‹ Back',
  'gate.cancelled': 'Sign-in cancelled. Try again whenever you like.',
  'gate.otherEmail': 'Another email',
});
Object.assign(dict.fr, {
  'gate.lead': 'Bienvenue sur Noera ! Connecte-toi pour commencer.',
  'gate.why': 'Ainsi ton profil reste le tien et revient si tu changes de téléphone — sans nouvelles photos.',
  'gate.have': 'Tu as déjà un profil sur ce téléphone : connecte-toi et il sera lié à ton compte. Tu ne perds rien.',
  'gate.email': '✉️ Connexion par e-mail',
  'gate.checking': 'Vérification de la connexion…',
  'gate.finishing': 'Finalisation de la connexion…',
  'gate.offline': 'Impossible de joindre le serveur Noera. Vérifie ta connexion internet et réessaie.',
  'gate.retry': '↻ Réessayer',
  'gate.back': '‹ Retour',
  'gate.cancelled': 'Connexion annulée. Réessaie quand tu veux.',
  'gate.otherEmail': 'Un autre e-mail',
});
Object.assign(dict.de, {
  'gate.lead': 'Willkommen bei Noera! Melde dich an, um zu starten.',
  'gate.why': 'So bleibt dein Profil deins und kommt zurück, wenn du das Handy wechselst — ohne neue Fotos.',
  'gate.have': 'Du hast schon ein Profil auf diesem Handy: Melde dich an, dann wird es mit deinem Konto verknüpft. Du verlierst nichts.',
  'gate.email': '✉️ Mit E-Mail anmelden',
  'gate.checking': 'Verbindung wird geprüft…',
  'gate.finishing': 'Anmeldung wird abgeschlossen…',
  'gate.offline': 'Ich erreiche den Noera-Server nicht. Prüfe dein Internet und versuche es erneut.',
  'gate.retry': '↻ Erneut versuchen',
  'gate.back': '‹ Zurück',
  'gate.cancelled': 'Anmeldung abgebrochen. Versuche es jederzeit erneut.',
  'gate.otherEmail': 'Andere E-Mail',
});

const OK_STATUS = ['restored', 'linked', 'already'];

export function createGate() {
  let on = true, finished = false, env = null, step = 'checking', emailAddr = '';   // «on» from the start: Google's answer can arrive before start()
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const g = { done, active: () => on && !finished, onResult, onFail, start, get step() { return step; } };

  function show(s) {
    step = s;
    const el = $('gate'); if (!el) return;
    const cfg = env.cfg, au = ((env.health() || {}).auth) || {};
    el.dataset.step = s;
    $('gateChecking').classList.toggle('hidden', !(s === 'checking' || s === 'busy'));
    if (s === 'checking' || s === 'busy') $('gateChecking').textContent = tr(s === 'busy' ? 'gate.finishing' : 'gate.checking');
    $('gateOff').classList.toggle('hidden', s !== 'off');
    $('gateOpts').classList.toggle('hidden', !(s === 'options' || s === 'email' || s === 'code'));
    $('gateGoogle').classList.toggle('hidden', !(s === 'options' && au.google_client_id));
    $('gateOr').classList.toggle('hidden', !(s === 'options' && au.google_client_id && au.email));
    $('gateEmailShow').classList.toggle('hidden', !(s === 'options' && au.email));
    $('gateEmailBox').classList.toggle('hidden', s !== 'email' && s !== 'code');
    $('gateEmailStep').classList.toggle('hidden', s !== 'email');
    $('gateCodeStep').classList.toggle('hidden', s !== 'code');
    $('gateBack').classList.toggle('hidden', !(s === 'email' || s === 'code'));
    $('gateHave').classList.toggle('hidden', !(cfg.token && (s === 'options' || s === 'email' || s === 'code')));
    $('gateLead').classList.toggle('hidden', s === 'off');
    $('gateWhy').classList.toggle('hidden', !(s === 'options'));
    $('gate').classList.remove('hidden'); document.body.classList.add('gate-on');
    try { applyI18n($('gate')); } catch (_) {}
    if (s === 'checking' || s === 'busy') $('gateChecking').textContent = tr(s === 'busy' ? 'gate.finishing' : 'gate.checking');
  }
  function setMsg(text, ok) { const m = $('gateMsg'); if (m) { m.textContent = text || ''; m.classList.toggle('ok', !!ok); } }

  function pass(info) {
    if (finished) return;
    finished = true; on = false;
    $('gate').classList.add('hidden'); document.body.classList.remove('gate-on');
    resolveDone(info || {});
  }
  // the account layer finished a sign-in (Google or email)
  function onResult(r) {
    if (finished) return;
    if (OK_STATUS.includes(r.status)) pass({ status: r.status, signedIn: true, now: true });
    else if (r.status === 'no_profile') pass({ status: r.status, newAccount: true, now: true });
    else { setMsg(tr('acc.googleFail')); show('options'); }
  }
  // a sign-in attempt failed / was declined: back to the buttons (or «retry» when only the network failed)
  function onFail(canRetry) { if (finished || !env) return; show(canRetry ? 'off' : 'options'); if (canRetry) $('gateOffMsg').textContent = tr('gate.offline'); }   // before start(): check() ends on the buttons anyway; the message stays

  const isNet = (e) => !!e && (e.code === 'offline' || e.code === 'timeout');

  async function check() {
    if (finished) return;
    const { cfg, api, account, hasCap, loadHealth, health } = env;
    // 1) already signed in on this device
    if (cfg.token && cfg.account) return pass({ already: true, signedIn: true });
    // 2) no server chosen at all (Settings → advanced → «only on this device»): the old behaviour
    if (!cfg.url) return pass({ fallback: true });
    show(account.hasPendingSignIn() ? 'busy' : 'checking');
    try { await loadHealth(); }
    catch (e) { if (finished) return; $('gateOffMsg').textContent = tr('gate.offline'); return show('off'); }
    if (finished) return;
    const au = ((health() || {}).auth) || {};
    // 3) the server has no sign-in set up (older server, or not configured): the old behaviour
    if (!(hasCap('accounts') && (au.google_client_id || au.email))) return pass({ fallback: true });
    // 4) a profile on this device that the server already knows as linked to an account (cfg.account was lost)
    if (cfg.token) {
      try {
        const r = await api.myAccounts();
        if (finished) return;
        if ((r.accounts || [])[0]) { account.setAccount(r.accounts[0]); return pass({ already: true, signedIn: true }); }
      } catch (e) {
        if (finished) return;
        if (isNet(e)) { $('gateOffMsg').textContent = tr('gate.offline'); return show('off'); }
        // a token the server no longer knows: sign in like a new user (the app clears the stale profile by itself)
      }
    }
    if (account.hasPendingSignIn()) { show('busy'); return; }   // Google's answer is being sent to the server right now
    show('options');
  }

  async function sendCode() {
    const email = ($('gEmail').value || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) { setMsg(tr('acc.badEmail')); $('gEmail').focus(); return; }
    $('gSend').disabled = true; setMsg(tr('acc.sending'));
    try {
      await env.api.emailStart(email);
      emailAddr = email;
      $('gCode').value = ''; show('code'); setMsg(tr('acc.codeSent', { email }), true);
      try { $('gCode').focus(); } catch (_) {}
    } catch (e) {
      setMsg('⚠️ ' + (e.code === 'too_soon' ? tr('acc.tooSoon') : e.code === 'too_many' ? tr('acc.tooMany') : isNet(e) ? tr('gate.offline') : env.errMsg(e)));
    } finally { $('gSend').disabled = false; }
  }
  async function verifyCode() {
    const code = ($('gCode').value || '').replace(/\D/g, '');
    if (code.length < 6) { setMsg(tr('acc.codeShort')); $('gCode').focus(); return; }
    $('gVerify').disabled = true;
    try { await env.account.verifyEmailCodeFor(emailAddr, code); }
    catch (e) { setMsg('⚠️ ' + (e.code === 'code_wrong' ? tr('acc.codeWrong') : e.code === 'code_expired' ? tr('acc.codeExpired') : isNet(e) ? tr('gate.offline') : env.errMsg(e))); }
    finally { $('gVerify').disabled = false; }
  }

  function start(e) {
    env = e; on = true;
    $('gateGoogle').onclick = () => env.account.signInWithGoogle();
    $('gateEmailShow').onclick = () => { setMsg(''); show('email'); try { $('gEmail').focus(); } catch (_) {} };
    $('gSend').onclick = sendCode;
    $('gEmail').onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); sendCode(); } };
    $('gVerify').onclick = verifyCode;
    $('gCode').onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); verifyCode(); } };
    $('gResend').onclick = () => { setMsg(''); show('email'); sendCode(); };
    $('gOther').onclick = () => { setMsg(''); show('email'); try { $('gEmail').focus(); } catch (_) {} };
    $('gateBack').onclick = () => { setMsg(''); show('options'); };
    $('gateRetry').onclick = () => { setMsg(''); if (!env.account.retryPendingGoogle()) check(); else show('busy'); };
    window.addEventListener('langchange', () => { if (!finished) show(step); });
    check();
    return g;
  }
  return g;
}
