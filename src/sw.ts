// The service worker, as a string served at swPath (default /sw.js).
//
// PUSH-ONLY: no fetch handler and no cache, so it never fights a server-
// rendered app's freshness. A project that already has its own worker can
// pull the push part in with importScripts('{basePath}/sw-push.js').

export interface WorkerOptions {
  appName: string;
  publicKey: string;
  basePath: string;
  icon: string;
  badge: string | null;
}

/** The push handlers alone (for importScripts into an existing worker). */
export function pushWorkerScript(o: WorkerOptions): string {
  const C = JSON.stringify({ app: o.appName, key: o.publicKey, base: o.basePath, icon: o.icon, badge: o.badge });
  return String.raw`// @xenastro/pwa-reach push handlers
(function () {
var C = ${C};

function ack(id) {
  if (!id) return Promise.resolve();
  return fetch(C.base + '/ack/' + encodeURIComponent(id), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: '{"event":"received"}', credentials: 'omit', keepalive: true
  }).catch(function () {});
}

// ALWAYS show a notification: iOS revokes the subscription after pushes that
// display nothing, and Chrome shows a generic "site updated in background" one.
// So a payload we can't read still produces a (generic) notification.
self.addEventListener('push', function (event) {
  var msg = {};
  try { msg = event.data ? event.data.json() : {}; }
  catch (e) { msg = { notification: { title: C.app, body: event.data ? event.data.text() : '' } }; }
  var n = msg.notification || {};
  var meta = msg.reach || {};
  var opts = {
    body: n.body || '',
    tag: n.tag || undefined,
    renotify: !!n.tag,
    icon: C.icon,
    timestamp: n.timestamp || Date.now(),
    lang: n.lang || undefined,
    dir: n.dir || 'auto',
    data: { url: n.navigate || '/', d: meta.d || null }
  };
  if (C.badge) opts.badge = C.badge; // Android small icon (alpha only); default is a bell
  var show = self.registration.showNotification(n.title || C.app, opts).catch(function () {
    return self.registration.showNotification(C.app, { body: n.body || '', data: { url: '/' } });
  });
  // Ack only after the notification is up, so "received" means "shown".
  event.waitUntil(show.then(function () { return ack(meta.d); }));
});

// Tap: open the notification's page. Two Android wrinkles seen in production
// (the tap loaded the page, then the start_url replaced it 28ms later):
//  - focus()+navigate() on a BACKGROUNDED installed-app window races Android
//    restoring the app at its start_url. So only navigate a window that is
//    already visible; otherwise openWindow(url) launches straight at the URL.
//  - Backstop: remember the tap for a few seconds; a page that loads
//    elsewhere in that window asks (see client.js) and redirects once.
var pending = null; // { url, at, landed, redirected }
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  // Always stay on this worker's origin (the app may answer on several hosts).
  try { var u = new URL(url, self.location.origin); url = self.location.origin + u.pathname + u.search + u.hash; }
  catch (e) { url = self.location.origin + '/'; }
  pending = { url: url, at: Date.now() };
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.visibilityState === 'visible' && 'navigate' in c) {
        return c.navigate(url).then(function (nc) { return nc && nc.focus ? nc.focus() : null; })
          .catch(function () { return self.clients.openWindow(url); });
      }
    }
    return self.clients.openWindow(url);
  }));
});

self.addEventListener('message', function (event) {
  var m = event.data || {};
  if (m.type !== 'pwa-reach-pending' || !event.source) return;
  var now = Date.now(), p = pending;
  // Live for 15s after the tap, but only 3s once the right page has loaded:
  // long enough to catch a start_url relaunch, short enough not to yank the
  // user back once they move on.
  if (p && (now - p.at > 15000 || (p.landed && now - p.landed > 3000))) p = pending = null;
  var url = null;
  if (p && m.path && new URL(p.url).pathname === m.path) { if (!p.landed) p.landed = now; }
  else if (p && !p.redirected) { url = p.url; p.redirected = true; p.landed = p.landed || now; } // once: no loops
  event.source.postMessage({ type: 'pwa-reach-pending', url: url });
});

function urlB64(s) {
  var pad = '='.repeat((4 - s.length % 4) % 4);
  var raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// The push service rotated or expired the subscription: get a new one and
// move the server row over, authorised by the old endpoint (a worker can't
// count on the session cookie). The page's on-open check is the backstop.
self.addEventListener('pushsubscriptionchange', function (event) {
  var oldSub = event.oldSubscription;
  event.waitUntil((event.newSubscription ? Promise.resolve(event.newSubscription)
    : self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(C.key) }))
    .then(function (sub) {
      return fetch(C.base + '/renew', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit',
        body: JSON.stringify({ oldEndpoint: oldSub ? oldSub.endpoint : null, subscription: sub.toJSON() })
      });
    }).catch(function () {}));
});
})();
`;
}

/** The whole worker: take over at once, plus the push handlers. The VAPID key
 *  is embedded, so a key change changes the bytes and the browser updates. */
export function serviceWorkerScript(o: WorkerOptions): string {
  return `// ${o.appName} service worker: push notifications only (no fetch handler, no cache).
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });
${pushWorkerScript(o)}`;
}
