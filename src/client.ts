// Browser side, served as one script at {basePath}/client.js plus a tiny
// inline stub from headTags(). Plain ES2017, no build step.
//
// The stub defines window.pwaReach.ready(fn) BEFORE anything else runs, so a
// page's own inline script can never race the client loading (the daftar
// launch bug: the settings page ran before the push script and showed
// "unsupported" everywhere). It also catches Android's beforeinstallprompt,
// which can fire before any UI exists.
//
// Install-state and in-app-browser ideas adapted from @baryodev/pwa-kit (MIT).

export interface ClientText {
  offerTitle: string;
  offerBody: string;
  enable: string;
  later: string;
  close: string;
  enabledTitle: string;
  enabledBody: string;
  deniedTitle: string;
  deniedAndroid: string;
  deniedAndroidApp: string;
  deniedIos: string;
  deniedDesktop: string;
  iosTitle: string;
  iosIntro: string;
  iosStep1: string;
  iosStep2: string;
  iosStep3: string;
  iosStep3SignIn: string;
  iosNoShare: string;
  inAppTitle: string;
  inAppBody: string;
  inAppHow: string;
  copyLink: string;
  copied: string;
  unsupportedTitle: string;
  unsupportedBody: string;
  installTitle: string;
  installBody: string;
  install: string;
  testTitle: string;
  testBody: string;
  failed: string;
}

export const DEFAULT_TEXT: ClientText = {
  offerTitle: "Get notified?",
  offerBody: "{app} can send a notification to this device when something needs you.",
  enable: "Enable",
  later: "Not now",
  close: "Close",
  enabledTitle: "Notifications are on ✓",
  enabledBody: "You'll get them on this device.",
  deniedTitle: "Notifications are blocked",
  deniedAndroid: "Tap the icon left of the address bar → Permissions → Notifications → Allow. Then reload the page.",
  deniedAndroidApp: "Long-press the {app} icon → App info → Notifications → turn them on. Then reopen {app}.",
  deniedIos: "Open iPhone Settings → Notifications → {app} → turn on Allow Notifications.",
  deniedDesktop: "Click the icon left of the address bar → Site settings → Notifications → Allow. Then reload the page.",
  iosTitle: "Add {app} to your Home Screen",
  iosIntro: "On iPhone, notifications only work in the Home Screen app.",
  iosStep1: "Tap the Share button (the square with an arrow) in Safari's toolbar.",
  iosStep2: "Scroll down, tap “Add to Home Screen”, then “Add”.",
  iosStep3: "Open {app} from your Home Screen.",
  iosStep3SignIn: "Open {app} from your Home Screen and sign in there once.",
  iosNoShare: "No “Add to Home Screen”? Open this page in Safari first.",
  inAppTitle: "Open this in your browser",
  inAppBody: "This page is open inside {inapp}, which can't install apps or show notifications. Open it in {browser} instead.",
  inAppHow: "Tap ⋮ or ••• and choose “Open in browser”, or copy the link and paste it there.",
  copyLink: "Copy link",
  copied: "Copied ✓",
  unsupportedTitle: "Not supported here",
  unsupportedBody: "This browser can't show notifications. Try Chrome on Android, Safari on iPhone, or a desktop browser.",
  installTitle: "Install {app}",
  installBody: "Add {app} to your home screen. It opens like an app.",
  install: "Install",
  testTitle: "{app} test notification",
  testBody: "Sent {time}. If you can read this, notifications work on this device.",
  failed: "Something went wrong: {error}",
};

const SHEET_CSS = `
.pr-sheet{position:fixed;left:12px;right:12px;bottom:calc(var(--pr-bottom,12px) + env(safe-area-inset-bottom,0px));z-index:2147483000;
  max-width:440px;margin:0 auto;box-sizing:border-box;background:var(--pr-bg,#fff);color:var(--pr-ink,#1c1c1c);
  border:1px solid var(--pr-line,rgba(127,127,127,.28));border-radius:var(--pr-radius,18px);box-shadow:0 12px 40px rgba(0,0,0,.28);
  padding:16px 18px;font-size:15px;line-height:1.45;animation:pr-in .22s ease-out}
@media (prefers-color-scheme:dark){.pr-sheet{background:var(--pr-bg,#1f2421);color:var(--pr-ink,#ececec)}}
@keyframes pr-in{from{transform:translateY(16px);opacity:0}to{transform:none;opacity:1}}
.pr-sheet .pr-x{position:absolute;top:6px;inset-inline-end:8px;border:0;background:none;color:inherit;opacity:.6;font-size:22px;line-height:1;padding:6px;cursor:pointer}
.pr-sheet .pr-title{font-weight:700;font-size:1.05em;margin:0 0 4px;margin-inline-end:30px}
.pr-sheet .pr-body,.pr-sheet .pr-note{margin:0 0 8px}
.pr-sheet .pr-note{opacity:.75;font-size:.9em}
.pr-sheet .pr-steps{margin:6px 0 8px;padding-inline-start:1.3em}
.pr-sheet .pr-steps li{margin:3px 0}
.pr-sheet .pr-msg{margin:0;font-size:.88em;opacity:.8}
.pr-sheet .pr-msg:empty{display:none}
.pr-sheet .pr-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap}
.pr-sheet .pr-btn{font:inherit;font-weight:600;border-radius:var(--pr-btn-radius,12px);padding:9px 16px;cursor:pointer;
  border:1px solid var(--pr-line,rgba(127,127,127,.35));background:transparent;color:inherit}
.pr-sheet .pr-primary{background:var(--pr-accent,#2e6b3f);color:var(--pr-accent-ink,#fff);border-color:transparent}
.pr-sheet .pr-btn:disabled{opacity:.6;cursor:default}
`.replace(/\n\s*/g, "");

export interface ClientOptions {
  appName: string;
  publicKey: string;
  basePath: string;
  swPath: string;
  text: ClientText;
  installReport: boolean;
}

export function clientScript(o: ClientOptions): string {
  const C = JSON.stringify({ app: o.appName, key: o.publicKey, base: o.basePath, sw: o.swPath, text: o.text, report: o.installReport });
  return String.raw`// @xenastro/pwa-reach client
(function () {
'use strict';
var C = ${C};
var T = C.text;
var CSS = ${JSON.stringify(SHEET_CSS)};
var stub = (window.pwaReach && window.pwaReach.q) ? window.pwaReach : { q: [] };
var LS = 'pwa-reach.';
function noop() {}
function lsGet(k) { try { return localStorage.getItem(LS + k); } catch (e) { return null; } }
function lsSet(k, v) { try { if (v == null) localStorage.removeItem(LS + k); else localStorage.setItem(LS + k, v); } catch (e) {} }
function fmt(s, vars) {
  return String(s || '').replace(/\{(\w+)\}/g, function (m, k) {
    if (vars && vars[k] != null) return vars[k];
    return k === 'app' ? C.app : m;
  });
}

// ── Environment ───────────────────────────────────────────────────────────
var ua = navigator.userAgent || '';
var ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); // iPadOS says "Macintosh"
var android = /Android/.test(ua);
var INAPP = [
  ['Telegram', /Telegram/i], ['WhatsApp', /WhatsApp/i], ['Instagram', /Instagram/], ['Facebook', /FBAN|FBAV|FB_IAB|FBIOS/],
  ['Messenger', /Messenger/], ['Snapchat', /Snapchat/], ['TikTok', /TikTok|musical_ly|BytedanceWebview/],
  ['LinkedIn', /LinkedInApp/], ['X', /Twitter/], ['LINE', /\bLine\//], ['WeChat', /MicroMessenger/]
];
function inApp() {
  for (var i = 0; i < INAPP.length; i++) if (INAPP[i][1].test(ua)) return INAPP[i][0];
  if (android && /; wv\)/.test(ua)) return 'an app';
  if (ios && !/Safari\//.test(ua)) return 'an app';
  return null;
}
function standalone() {
  try {
    if (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches ||
        matchMedia('(display-mode: minimal-ui)').matches) return true;
  } catch (e) {}
  return navigator.standalone === true;
}
function platform() { return ios ? 'ios' : android ? 'android' : /Windows|Macintosh|Linux|CrOS/.test(ua) ? 'desktop' : 'other'; }
function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
function isOff() { return lsGet('off') === '1'; }
function setOff(v) { lsSet('off', v ? '1' : null); }
function keyBytes(s) {
  var pad = '='.repeat((4 - s.length % 4) % 4);
  var raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function sameKey(buf) {
  if (!buf) return false;
  var a = new Uint8Array(buf), b = keyBytes(C.key);
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function post(path, body) {
  return fetch(C.base + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify(body || {})
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      j = j || {}; j.httpStatus = r.status;
      if (!r.ok) j.ok = false;
      return j;
    });
  });
}
var listeners = [];
function emit() { listeners.slice().forEach(function (f) { try { f(); } catch (e) { console.error(e); } }); }

// ── Push ──────────────────────────────────────────────────────────────────
function registration() {
  return navigator.serviceWorker.register(C.sw, { scope: '/', updateViaCache: 'none' })
    .then(function () { return navigator.serviceWorker.ready; });
}
async function subscription() {
  if (!pushSupported()) return null;
  var reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}
// Get (or create) a subscription on the current key, then send it to the server.
async function ensure(reason) {
  if (!C.key) throw new Error('push is not configured on the server');
  var reg = await registration();
  var sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options && sub.options.applicationServerKey)) {
    await sub.unsubscribe().catch(noop);
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(C.key) });
  var j = await post('/subscribe', { subscription: sub.toJSON(), platform: platform(), reason: reason });
  if (!j.ok) throw new Error(j.error || ('HTTP ' + j.httpStatus));
  return { subscription: sub, server: j };
}
// on | off | denied | ios-install | in-app | unsupported
async function pushState() {
  if (inApp()) return 'in-app';
  if (ios && !standalone()) return 'ios-install';
  if (!pushSupported() || !C.key) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'granted' && !isOff()) {
    var s = await subscription().catch(function () { return null; });
    if (s) return 'on';
  }
  return 'off';
}
// Must be called from a tap: it shows the browser's permission prompt.
async function enable() {
  var st = await pushState();
  if (st === 'on') return { ok: true, state: 'on' };
  if (st !== 'off') return { ok: false, state: st };
  var p = await Notification.requestPermission();
  if (p !== 'granted') return { ok: false, state: p === 'denied' ? 'denied' : 'off' };
  setOff(false);
  try { await ensure('enable'); emit(); return { ok: true, state: 'on' }; }
  catch (e) { return { ok: false, state: 'off', error: String(e && e.message || e) }; }
}
async function disable() {
  setOff(true);
  var s = await subscription().catch(function () { return null; });
  if (s) {
    await post('/unsubscribe', { endpoint: s.endpoint }).catch(noop);
    await s.unsubscribe().catch(noop);
  }
  emit();
}
async function setPrefs(prefs) {
  var s = await subscription();
  if (!s) return { ok: false, error: 'not subscribed' };
  return post('/prefs', { endpoint: s.endpoint, prefs: prefs == null ? null : String(prefs) });
}
// endpoint: true = this device, a string = that device, empty = all my devices.
async function test(endpoint) {
  if (endpoint === true) {
    var s = await subscription();
    if (!s) return { ok: false, error: 'not subscribed' };
    endpoint = s.endpoint;
  }
  return post('/test', { endpoint: endpoint || undefined });
}

// ── Install ───────────────────────────────────────────────────────────────
var bip = stub.bip || null, justInstalled = false;
window.addEventListener('beforeinstallprompt', function (e) { if (stub.capture !== false) e.preventDefault(); bip = e; emit(); });
window.addEventListener('appinstalled', function () { bip = null; justInstalled = true; report(true); emit(); });
// installed | prompt | ios-steps | in-app | unavailable
function installState() {
  if (justInstalled || standalone()) return 'installed';
  if (inApp()) return 'in-app';
  if (ios) return 'ios-steps';
  if (bip) return 'prompt';
  return 'unavailable';
}
async function install() {
  var st = installState();
  if (st === 'ios-steps') { help('ios-steps', { forPush: false }); return st; }
  if (st === 'in-app') { help('in-app'); return st; }
  if (st !== 'prompt') return st;
  var e = bip; bip = null;
  try {
    await e.prompt();
    var c = await e.userChoice;
    emit();
    return (c && c.outcome) || 'dismissed';
  } catch (x) { bip = e; return 'unavailable'; }
}

// ── Snooze ("Not now" is remembered) ─────────────────────────────────────
function snoozed(id) { return Number(lsGet('snooze.' + id) || 0) > Date.now(); }
function snooze(id, days) { lsSet('snooze.' + id, String(Date.now() + (days == null ? 14 : days) * 864e5)); }
function unsnooze(id) { lsSet('snooze.' + id, null); }

// ── The sheet (our own banner; the browser prompt only follows a tap) ─────
var sheet = null, sheetClose = null;
function css() {
  if (document.getElementById('pwa-reach-css')) return;
  var s = document.createElement('style'); s.id = 'pwa-reach-css'; s.textContent = CSS;
  document.head.appendChild(s);
}
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function close() { if (sheet) { sheet.remove(); sheet = null; sheetClose = null; } }
function show(v) {
  css(); close();
  var root = el('div', 'pr-sheet');
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-live', 'polite'); root.dir = 'auto';
  var x = el('button', 'pr-x', '×'); x.type = 'button'; x.setAttribute('aria-label', T.close);
  x.onclick = function () { var f = sheetClose; close(); if (f) f(); };
  root.appendChild(x);
  if (v.title) root.appendChild(el('div', 'pr-title', v.title));
  if (v.body) root.appendChild(el('p', 'pr-body', v.body));
  if (v.steps) { var ol = el('ol', 'pr-steps'); v.steps.forEach(function (s) { if (s) ol.appendChild(el('li', null, s)); }); root.appendChild(ol); }
  if (v.note) root.appendChild(el('p', 'pr-note', v.note));
  var msg = el('p', 'pr-msg'); root.appendChild(msg);
  if (v.actions && v.actions.length) {
    var row = el('div', 'pr-actions');
    v.actions.forEach(function (a) {
      var b = el('button', 'pr-btn' + (a.primary ? ' pr-primary' : ''), a.label); b.type = 'button';
      b.onclick = function () { a.run(b, msg); };
      row.appendChild(b);
    });
    root.appendChild(row);
  }
  document.body.appendChild(root);
  sheet = root; sheetClose = v.onClose || null;
  return root;
}
function copy(t) {
  function fallback() {
    var i = document.createElement('textarea'); i.value = t; document.body.appendChild(i); i.select();
    try { document.execCommand('copy'); } catch (e) {}
    i.remove(); return Promise.resolve();
  }
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t).catch(fallback);
  return fallback();
}
function deniedText() {
  if (ios) return T.deniedIos;
  if (android) return standalone() ? T.deniedAndroidApp : T.deniedAndroid;
  return T.deniedDesktop;
}
// Explain a state: denied | ios-install | ios-steps | in-app | unsupported.
function help(state, o) {
  o = o || {};
  var done = { label: T.close, run: function () { var f = sheetClose; close(); if (f) f(); } };
  if (state === 'denied') return show({ title: fmt(T.deniedTitle), body: fmt(deniedText()), actions: [done], onClose: o.onClose });
  if (state === 'ios-install' || state === 'ios-steps') {
    return show({
      title: fmt(T.iosTitle),
      body: o.forPush === false ? null : fmt(T.iosIntro),
      steps: [fmt(T.iosStep1), fmt(T.iosStep2), fmt(o.signIn ? T.iosStep3SignIn : T.iosStep3)],
      note: fmt(T.iosNoShare),
      actions: [done], onClose: o.onClose
    });
  }
  if (state === 'in-app') {
    return show({
      title: fmt(T.inAppTitle),
      body: fmt(T.inAppBody, { inapp: inApp() || 'an app', browser: ios ? 'Safari' : 'Chrome' }),
      note: fmt(T.inAppHow),
      actions: [{ label: T.copyLink, primary: true, run: function (b) { copy(location.href).then(function () { b.textContent = T.copied; }); } }, done],
      onClose: o.onClose
    });
  }
  if (state === 'unsupported') return show({ title: fmt(T.unsupportedTitle), body: fmt(T.unsupportedBody), actions: [done], onClose: o.onClose });
  return null;
}

// Offer notifications at a moment the project picks. Shows nothing when
// they're already on, unsupported, blocked (unless force) or snoozed.
// o: { id, title, body, enable, later, snoozeDays, force, signIn, onDone(result) }
async function offer(o) {
  o = o || {};
  var id = 'push:' + (o.id || 'default');
  var st = await pushState();
  if (st === 'on' || (st === 'unsupported' && !o.force)) return st;
  if (!o.force && snoozed(id)) return 'snoozed';
  function dismiss() { snooze(id, o.snoozeDays); close(); if (o.onDone) o.onDone('later'); }
  if (st === 'denied') { if (o.force) help('denied'); return st; }
  if (st === 'unsupported') { help('unsupported'); return st; }
  if (st === 'in-app') { help('in-app', { onClose: dismiss }); return st; }
  if (st === 'ios-install') { help('ios-install', { signIn: o.signIn !== false, onClose: dismiss }); return st; }
  show({
    title: o.title || fmt(T.offerTitle),
    body: o.body || fmt(T.offerBody),
    actions: [
      { label: o.enable || T.enable, primary: true, run: function (b, msg) {
        b.disabled = true; msg.textContent = '';
        enable().then(function (r) {
          if (r.ok) {
            show({ title: fmt(T.enabledTitle), body: fmt(T.enabledBody) });
            setTimeout(close, 2500);
            if (o.onDone) o.onDone('on');
          } else if (r.state === 'denied') {
            help('denied'); if (o.onDone) o.onDone('denied');
          } else {
            b.disabled = false; msg.textContent = fmt(T.failed, { error: r.error || r.state });
          }
        });
      } },
      { label: o.later || T.later, run: dismiss }
    ],
    onClose: dismiss
  });
  return st;
}

// Offer installing. o: { id, title, body, install, later, snoozeDays, force, signIn, onDone(result) }
async function offerInstall(o) {
  o = o || {};
  var id = 'install:' + (o.id || 'default');
  var st = installState();
  if (st === 'installed' || st === 'unavailable') return st;
  if (!o.force && snoozed(id)) return 'snoozed';
  function dismiss() { snooze(id, o.snoozeDays); close(); if (o.onDone) o.onDone('later'); }
  if (st === 'in-app') { help('in-app', { onClose: dismiss }); return st; }
  if (st === 'ios-steps') { help('ios-steps', { forPush: false, signIn: !!o.signIn, onClose: dismiss }); return st; }
  show({
    title: o.title || fmt(T.installTitle),
    body: o.body || fmt(T.installBody),
    actions: [
      { label: o.install || T.install, primary: true, run: function () {
        install().then(function (r) { close(); if (r === 'dismissed') snooze(id, o.snoozeDays); if (o.onDone) o.onDone(r); });
      } },
      { label: o.later || T.later, run: dismiss }
    ],
    onClose: dismiss
  });
  return st;
}

// ── Install reporting: once a day per device (and on appinstalled) ───────
function rid() {
  var b = new Uint8Array(16); crypto.getRandomValues(b);
  return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
}
function report(installedNow) {
  if (!C.report) return;
  var mode = standalone() ? 'standalone' : 'browser';
  var key = mode + '@' + new Date().toISOString().slice(0, 10) + (stub.signedIn ? '+u' : '');
  if (!installedNow && lsGet('reported') === key) return;
  lsSet('reported', key);
  var id = lsGet('device');
  if (!id) { id = rid(); lsSet('device', id); }
  post('/install', { deviceId: id, displayMode: mode, installed: !!installedNow || mode === 'standalone', platform: platform(), inApp: inApp() }).catch(noop);
}

// ── Notification-tap backstop (see sw.js): Android may relaunch the app at
//    its start_url right after we opened the tapped page; go back once. ────
if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
  navigator.serviceWorker.addEventListener('message', function (e) {
    var m = e.data || {};
    if (m.type === 'pwa-reach-pending' && m.url && new URL(m.url).pathname !== location.pathname) location.replace(m.url);
  });
  navigator.serviceWorker.controller.postMessage({ type: 'pwa-reach-pending', path: location.pathname });
}

// ── On every open: re-check and re-send this device's subscription. Never prompts.
var synced = Promise.resolve(null);
if (pushSupported() && C.key && stub.signedIn !== false && Notification.permission === 'granted' && !isOff()) {
  synced = ensure('open').catch(function (e) { console.warn('[pwa-reach] on-open check failed:', e && e.message || e); return null; })
    .then(function (r) { emit(); return r; });
}
report(false);

var api = {
  version: 1,
  signedIn: stub.signedIn,
  env: function () {
    return { ios: ios, android: android, platform: platform(), standalone: standalone(), inApp: inApp(), pushSupported: pushSupported() };
  },
  pushState: pushState, enable: enable, disable: disable, subscription: subscription, setPrefs: setPrefs, test: test, isOff: isOff,
  installState: installState, install: install,
  offer: offer, offerInstall: offerInstall, help: help, close: close,
  snooze: snooze, snoozed: snoozed, unsnooze: unsnooze,
  synced: function () { return synced; },
  on: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
  ready: function (fn) { try { fn(api); } catch (e) { console.error(e); } }
};
window.pwaReach = api;
(stub.q || []).forEach(api.ready);
})();
`;
}

/** Inline stub + deferred client: goes in every page's <head>. */
export function headSnippet(o: { clientUrl: string; signedIn?: boolean; captureInstallPrompt: boolean }): string {
  const signed = o.signedIn === undefined ? "undefined" : o.signedIn ? "true" : "false";
  return (
    `<script>(function(w){var r=w.pwaReach=w.pwaReach||{q:[]};r.q=r.q||[];r.ready=r.ready||function(f){r.q.push(f)};` +
    `r.signedIn=${signed};r.capture=${o.captureInstallPrompt};` +
    `w.addEventListener('beforeinstallprompt',function(e){if(r.capture)e.preventDefault();r.bip=e;});})(window);</script>` +
    `<script src="${o.clientUrl.replace(/"/g, "&quot;")}" defer></script>`
  );
}
