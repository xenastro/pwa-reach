// Server-rendered pieces for a project's notifications page. Plain HTML
// strings (no templating dependency), so they drop into hono/html, a custom
// html`` helper or anything else as raw HTML. Wrap them in your own cards and
// headings. Styling: include `uiCss` once and map the --pr-* variables onto
// your theme (they fall back to neutral defaults).

import type { EventLog, InstallSummary, Subscription } from "./types.js";
import type { ReachStats } from "./core.js";

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON for embedding inside <script>. */
const js = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export const uiCss = `
.pr-card-status{font-size:.95rem;margin:.2rem 0 .8rem}
.pr-ok{color:var(--pr-good,#23803b)}.pr-bad{color:var(--pr-bad,#b83a2c)}.pr-warn{color:var(--pr-warn,#a86a12)}
.pr-row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin:.5rem 0}
.pr-ui .pr-btn{font:inherit;font-weight:600;border-radius:var(--pr-btn-radius,12px);padding:.5rem 1rem;cursor:pointer;
  border:1px solid var(--pr-line,rgba(127,127,127,.35));background:transparent;color:inherit}
.pr-ui .pr-primary{background:var(--pr-accent,#2e6b3f);color:var(--pr-accent-ink,#fff);border-color:transparent}
.pr-ui .pr-small{padding:.25rem .6rem;font-size:.8rem}
.pr-prefs label{display:flex;gap:.45rem;align-items:flex-start;padding:.35rem 0;cursor:pointer;font-size:.9rem}
.pr-prefs small{color:var(--pr-muted,#777);display:block}
.pr-msg{font-size:.85rem;color:var(--pr-muted,#777);min-height:1.2em;margin-top:.4rem;white-space:pre-line}
.pr-tip{font-size:.8rem;color:var(--pr-muted,#777);border-inline-start:3px solid var(--pr-line,rgba(127,127,127,.35));padding:.2rem .7rem;margin:.7rem 0 0}
.pr-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(7.5rem,1fr));gap:.6rem;margin:.4rem 0 .8rem}
.pr-kpi{background:var(--pr-panel,rgba(127,127,127,.1));border-radius:8px;padding:.55rem .7rem}
.pr-kpi b{display:block;font-size:1.25rem;font-variant-numeric:tabular-nums}
.pr-kpi span{font-size:.72rem;color:var(--pr-muted,#777);text-transform:uppercase;letter-spacing:.03em}
.pr-scroll{overflow-x:auto}
table.pr-t{width:100%;border-collapse:collapse;font-size:.82rem}
.pr-t th{text-align:start;color:var(--pr-muted,#777);font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.03em;padding:.3rem .4rem}
.pr-t td{padding:.42rem .4rem;border-top:1px solid var(--pr-line,rgba(127,127,127,.25));vertical-align:top}
.pr-t .pr-muted,.pr-muted{color:var(--pr-muted,#777)}
.pr-t tr.pr-me td:first-child{box-shadow:inset 3px 0 0 var(--pr-accent,#2e6b3f)}
.pr-chip{display:inline-block;font-size:.7rem;padding:.05rem .45rem;border-radius:.6rem;margin:.1rem .2rem .1rem 0;white-space:nowrap}
.pr-chip.ok{background:color-mix(in srgb,var(--pr-good,#23803b) 18%,transparent);color:var(--pr-good,#23803b)}
.pr-chip.open{background:color-mix(in srgb,var(--pr-accent,#2e6b3f) 18%,transparent);color:var(--pr-accent,#2e6b3f)}
.pr-chip.wait{background:color-mix(in srgb,var(--pr-warn,#a86a12) 18%,transparent);color:var(--pr-warn,#a86a12)}
.pr-chip.bad{background:color-mix(in srgb,var(--pr-bad,#b83a2c) 18%,transparent);color:var(--pr-bad,#b83a2c)}
.pr-chip.none{background:var(--pr-panel,rgba(127,127,127,.1));color:var(--pr-muted,#777)}
.pr-body{color:var(--pr-muted,#777);font-size:.76rem;white-space:pre-line}
@media (max-width:700px){.pr-hide-sm{display:none}}
`;

export interface FormatOptions {
  /** IANA zone for dates, e.g. "Asia/Amman". */
  timeZone?: string;
}

export function fmtWhen(d: Date | null | undefined, o: FormatOptions = {}): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-GB", { timeZone: o.timeZone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function ago(d: Date | null | undefined, now = Date.now()): string {
  if (!d) return "—";
  const s = Math.round((now - new Date(d).getTime()) / 1000);
  if (s < 60) return `${Math.max(0, s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function lag(from: Date, to: Date | null): string {
  if (!to) return "";
  const s = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");

export function uaShort(ua: string | null): string {
  if (!ua) return "";
  const os =
    /Android [\d.]+/.exec(ua)?.[0] ??
    /iPhone OS [\d_]+/.exec(ua)?.[0]?.replace(/_/g, ".") ??
    /Windows NT [\d.]+/.exec(ua)?.[0] ??
    /Mac OS X [\d_]+/.exec(ua)?.[0]?.replace(/_/g, ".") ??
    "";
  const br =
    /EdgA?\/\d+/.exec(ua)?.[0] ??
    /SamsungBrowser\/\d+/.exec(ua)?.[0] ??
    /Firefox\/\d+/.exec(ua)?.[0] ??
    /Chrome\/\d+/.exec(ua)?.[0] ??
    /Version\/[\d.]+.*Safari/.exec(ua)?.[0]?.replace(/ .*$/, "") ??
    "";
  return [os, br].filter(Boolean).join(" · ");
}

export interface PrefsChoice {
  value: string;
  label: string;
  hint?: string;
}

let seq = 0;

/**
 * "This device": status, Enable / Send a test / Turn off, help for blocked,
 * iPhone and in-app states, optional per-device prefs, platform tips. Its
 * script runs through pwaReach.ready(), so it can't race the client script.
 */
export function deviceCard(o: { appName: string; prefs?: PrefsChoice[]; androidTip?: boolean } = { appName: "" }): string {
  const id = `pr-dev-${++seq}`;
  const prefs = o.prefs?.length
    ? `<div class="pr-prefs" hidden>${o.prefs
        .map(
          (p) => `<label><input type="radio" name="${id}-prefs" value="${esc(p.value)}" />
            <span>${esc(p.label)}${p.hint ? `<small>${esc(p.hint)}</small>` : ""}</span></label>`,
        )
        .join("")}</div>`
    : "";
  const tip =
    o.androidTip !== false
      ? `<p class="pr-tip" data-pr-tip="android" hidden>Android: for reliable delivery set Chrome's battery usage to <b>Unrestricted</b>
         (Settings → Apps → Chrome → Battery). Xiaomi, Oppo, Vivo, Huawei and Samsung may stop it otherwise.</p>`
      : "";
  return `<div class="pr-ui" id="${id}">
  <p class="pr-card-status">Checking…</p>
  <div class="pr-row">
    <button type="button" class="pr-btn pr-primary" data-pr="enable" hidden>Enable notifications</button>
    <button type="button" class="pr-btn pr-primary" data-pr="help" hidden>Show me how</button>
    <button type="button" class="pr-btn pr-primary" data-pr="test" hidden>Send me a test</button>
    <button type="button" class="pr-btn" data-pr="disable" hidden>Turn off on this device</button>
  </div>
  ${prefs}
  <div class="pr-msg"></div>
  ${tip}
</div>
<script>
(window.pwaReach = window.pwaReach || { q: [] }).ready = window.pwaReach.ready || function (f) { window.pwaReach.q.push(f); };
window.pwaReach.ready(function (R) {
  var root = document.getElementById(${js(id)});
  var APP = ${js(o.appName)};
  function $(s) { return root.querySelector(s); }
  function msg(t) { $('.pr-msg').textContent = t || ''; }
  function show(k, on) { var b = $('[data-pr="' + k + '"]'); if (b) b.hidden = !on; }
  var STATUS = {
    on: ['✓ Notifications are on for this device.', 'pr-ok'],
    off: ['Notifications are off on this device.', 'pr-warn'],
    denied: ['Notifications are blocked for ' + APP + ' in this browser.', 'pr-bad'],
    'ios-install': ['On iPhone, notifications only work after adding ' + APP + ' to the Home Screen.', 'pr-warn'],
    'in-app': ['This page is open inside another app, which can\\'t show notifications.', 'pr-warn'],
    unsupported: ['This browser can\\'t show notifications.', 'pr-bad']
  };
  var state = null;
  async function render() {
    state = await R.pushState();
    var s = STATUS[state] || ['', ''];
    var el = $('.pr-card-status'); el.textContent = s[0]; el.className = 'pr-card-status ' + s[1];
    show('enable', state === 'off');
    show('help', state === 'denied' || state === 'ios-install' || state === 'in-app');
    show('test', state === 'on');
    show('disable', state === 'on');
    var prefs = $('.pr-prefs'); if (prefs) prefs.hidden = state !== 'on';
    var tip = $('[data-pr-tip="android"]'); if (tip) tip.hidden = !R.env().android;
    var sub = state === 'on' ? await R.subscription().catch(function () { return null; }) : null;
    document.querySelectorAll('tr[data-pr-endpoint]').forEach(function (tr) {
      var me = !!sub && tr.getAttribute('data-pr-endpoint') === sub.endpoint;
      tr.classList.toggle('pr-me', me);
      var tag = tr.querySelector('.pr-this'); if (tag) tag.textContent = me ? '(this device)' : '';
      if (me && prefs) {
        var v = tr.getAttribute('data-pr-prefs') || '';
        prefs.querySelectorAll('input').forEach(function (r) { r.checked = r.value === v || (!v && r === prefs.querySelector('input')); });
      }
    });
  }
  function testResult(j) {
    if (!j.results) { msg(j.error || 'Could not send.'); return; }
    msg(j.results.map(function (x) {
      return (x.platform || 'device') + ': ' + (x.status >= 200 && x.status < 300 ? 'accepted by the push service ✓' : x.gone ? 'expired, removed' : 'failed (' + x.status + ') ' + (x.error || ''));
    }).join('\\n') + '\\nThe phone confirms receipt under Recent notifications.');
  }
  root.addEventListener('click', function (e) {
    var b = e.target.closest('[data-pr]'); if (!b) return;
    var k = b.getAttribute('data-pr');
    if (k === 'enable') {
      msg('Asking for permission…');
      R.enable().then(function (r) {
        // No automatic test: a tap on "Send me a test" right after would deliver two.
        if (r.ok) { msg('Enabled ✓ Tap "Send me a test" to check it arrives.'); render(); return; }
        if (r.state === 'denied') { msg(''); R.help('denied'); }
        else msg(r.error || ('Not enabled (' + r.state + ').'));
        render();
      });
    } else if (k === 'help') { R.help(state, { signIn: true }); }
    else if (k === 'test') { msg('Sending…'); R.test(true).then(testResult); }
    else if (k === 'disable') { msg('Turning off…'); R.disable().then(function () { location.reload(); }); }
  });
  root.addEventListener('change', function (e) {
    if (!e.target.matches('.pr-prefs input')) return;
    R.setPrefs(e.target.value).then(function (j) { msg(j.ok ? 'Saved for this device.' : 'Could not save.'); });
  });
  R.on(render);
  render();
});
</script>`;
}

/** The owner's devices, with Test / Remove. The device card marks "this device". */
export function devicesTable(
  devices: Subscription[],
  o: FormatOptions & { basePath?: string; prefsLabel?: (prefs: string | null) => string } = {},
): string {
  if (!devices.length) return `<p class="pr-muted">No device has notifications on yet.</p>`;
  const id = `pr-devs-${++seq}`;
  const base = (o.basePath ?? "/reach").replace(/\/+$/, "");
  const rows = devices
    .map(
      (d) => `<tr data-pr-endpoint="${esc(d.endpoint)}" data-pr-prefs="${esc(d.prefs ?? "")}" data-pr-id="${d.id}">
      <td><b>${esc(d.platform ?? "?")}</b> <span class="pr-this pr-muted"></span><br /><span class="pr-muted">${esc(uaShort(d.userAgent))}</span><br />
        <span class="pr-muted">since ${esc(fmtWhen(d.createdAt, o))}</span></td>
      ${o.prefsLabel ? `<td>${esc(o.prefsLabel(d.prefs))}</td>` : ""}
      <td class="pr-hide-sm">${esc(ago(d.lastSeenAt))}</td>
      <td class="pr-hide-sm">${esc(ago(d.lastSentAt))}</td>
      <td>${esc(ago(d.lastDeliveredAt))}</td>
      <td class="pr-hide-sm">${d.failCount ? `<span class="pr-chip bad" title="${esc(d.lastError ?? "")}">${d.failCount} in a row</span>` : `<span class="pr-muted">—</span>`}</td>
      <td style="white-space:nowrap"><button type="button" class="pr-btn pr-small" data-pr-act="test">Test</button>
        <button type="button" class="pr-btn pr-small" data-pr-act="remove">Remove</button></td>
    </tr>`,
    )
    .join("");
  return `<div class="pr-ui pr-scroll" id="${id}"><table class="pr-t">
  <thead><tr><th>Device</th>${o.prefsLabel ? "<th>Gets</th>" : ""}<th class="pr-hide-sm">App opened</th><th class="pr-hide-sm">Last sent</th><th>Last received</th><th class="pr-hide-sm">Errors</th><th></th></tr></thead>
  <tbody>${rows}</tbody></table><div class="pr-msg"></div></div>
<script>
(function () {
  var root = document.getElementById(${js(id)}), BASE = ${js(base)};
  function msg(t) { root.querySelector('.pr-msg').textContent = t || ''; }
  root.addEventListener('click', function (e) {
    var b = e.target.closest('[data-pr-act]'); if (!b) return;
    var tr = b.closest('tr'), act = b.getAttribute('data-pr-act');
    function post(path, body) {
      return fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body || {}) })
        .then(function (r) { return r.json().catch(function () { return {}; }); });
    }
    if (act === 'test') {
      msg('Sending…');
      post('/test', { endpoint: tr.getAttribute('data-pr-endpoint') }).then(function (j) {
        var x = (j.results || [])[0];
        msg(x ? (x.status >= 200 && x.status < 300 ? 'Accepted by the push service ✓' : x.gone ? 'Expired, removed.' : 'Failed (' + x.status + ') ' + (x.error || '')) : (j.error || 'Could not send.'));
      });
    } else if (act === 'remove') {
      if (!confirm('Remove this device? It stops getting notifications until they are enabled on it again.')) return;
      post('/devices/' + tr.getAttribute('data-pr-id') + '/delete').then(function (j) { if (j.ok) tr.remove(); else msg('Could not remove.'); });
    }
  });
})();
</script>`;
}

/** Scorecard: decided → accepted → received → opened, by platform, plus latency. */
export function scorecard(s: ReachStats | null, o: FormatOptions = {}): string {
  if (!s) return `<p class="pr-muted">No data.</p>`;
  const days = Math.max(0, Math.floor((Date.now() - s.since.getTime()) / 86400_000));
  const plat = s.byPlatform.length
    ? `<table class="pr-t"><thead><tr><th>Platform</th><th>Sent</th><th>Accepted</th><th>Received</th><th>Opened</th></tr></thead><tbody>${s.byPlatform
        .map(
          (p) => `<tr><td>${esc(p.platform)}</td><td>${p.deliveries}</td><td>${p.accepted}</td>
            <td>${p.received} <span class="pr-muted">(${pct(p.received, p.accepted)})</span></td><td>${p.opened}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="pr-muted">Nothing sent yet.</p>`;
  const lat = s.latency
    ? `<p class="pr-muted" style="font-size:.8rem">Time to reach the device: median ${s.latency.p50.toFixed(1)}s · 90% within ${s.latency.p90.toFixed(1)}s · slowest ${s.latency.max.toFixed(0)}s</p>`
    : "";
  return `<div class="pr-ui">
  <p class="pr-muted" style="font-size:.85rem">Since ${esc(fmtWhen(s.since, o))} (${days} day${days === 1 ? "" : "s"}), test pushes excluded.
    "Received" means the device confirmed it showed the notification (a lower bound; a tap also counts).</p>
  <div class="pr-kpis">
    <div class="pr-kpi"><b>${s.events}</b><span>notifications</span></div>
    <div class="pr-kpi"><b>${pct(s.eventsReached, s.events)}</b><span>reached a device</span></div>
    <div class="pr-kpi"><b>${s.accepted}/${s.deliveries}</b><span>accepted by push service</span></div>
    <div class="pr-kpi"><b>${s.received}/${s.accepted}</b><span>received</span></div>
    <div class="pr-kpi"><b>${s.opened}</b><span>opened</span></div>
    <div class="pr-kpi"><b>${s.eventsNoDevice}</b><span>no device on</span></div>
  </div>
  ${plat}${lat}
</div>`;
}

const UNCONFIRMED_MIN = 10;

function deliveryChip(e: EventLog, d: EventLog["deliveries"][number], who: string): string {
  if (d.pushStatus == null) return `<span class="pr-chip none">${esc(who)}: sending…</span>`;
  if (d.pushStatus < 200 || d.pushStatus > 299) {
    const why = d.pushStatus === 404 || d.pushStatus === 410 ? "expired, removed" : d.pushStatus === 0 ? "network error" : `push service ${d.pushStatus}`;
    return `<span class="pr-chip bad" title="${esc(d.error ?? "")}">${esc(who)}: ✗ ${esc(why)}</span>`;
  }
  if (d.openedAt) return `<span class="pr-chip open">${esc(who)}: opened ${lag(e.createdAt, d.openedAt)}</span>`;
  if (d.receivedAt) return `<span class="pr-chip ok">${esc(who)}: ✓ received ${lag(e.createdAt, d.receivedAt)}</span>`;
  const old = Date.now() - e.createdAt.getTime() > UNCONFIRMED_MIN * 60_000;
  return `<span class="pr-chip ${old ? "bad" : "wait"}">${esc(who)}: ${old ? "⚠ not confirmed" : "⏳ waiting"}</span>`;
}

/** The last notifications with per-device receipt. `ownerLabel` names each device's owner (multi-user views). */
export function recentTable(events: EventLog[], o: FormatOptions & { ownerLabel?: (owner: string | null) => string } = {}): string {
  if (!events.length) return `<p class="pr-muted">No notifications yet.</p>`;
  return `<div class="pr-ui pr-scroll"><table class="pr-t">
  <thead><tr><th>When</th><th>Notification</th><th>Delivery</th></tr></thead>
  <tbody>${events
    .map(
      (e) => `<tr>
      <td style="white-space:nowrap">${esc(fmtWhen(e.createdAt, o))}<br /><span class="pr-muted">${esc(e.kind)}</span></td>
      <td>${e.url ? `<a href="${esc(e.url)}">${esc(e.title)}</a>` : esc(e.title)}<div class="pr-body" dir="auto">${esc(e.body ?? "")}</div></td>
      <td>${
        e.deliveries.length
          ? e.deliveries
              .map((d) => deliveryChip(e, d, o.ownerLabel ? `${o.ownerLabel(d.owner)} · ${d.platform ?? "device"}` : d.platform ?? "device"))
              .join("")
          : `<span class="pr-chip none">no device on</span>`
      }</td>
    </tr>`,
    )
    .join("")}</tbody></table>
  <p class="pr-muted" style="font-size:.78rem">"Not confirmed" = no receipt ${UNCONFIRMED_MIN}+ minutes after the push service accepted it; it may not have shown.</p></div>`;
}

/** Devices seen per platform, how many run installed, how many came from in-app browsers. */
export function installsTable(rows: InstallSummary[]): string {
  if (!rows.length) return `<p class="pr-muted">No devices reported yet.</p>`;
  return `<div class="pr-ui pr-scroll"><table class="pr-t">
  <thead><tr><th>Platform</th><th>Devices</th><th>Installed</th><th>In-app browser</th></tr></thead>
  <tbody>${rows
    .map((r) => `<tr><td>${esc(r.platform)}</td><td>${r.devices}</td><td>${r.installed} <span class="pr-muted">(${pct(r.installed, r.devices)})</span></td><td>${r.inApp}</td></tr>`)
    .join("")}</tbody></table></div>`;
}
