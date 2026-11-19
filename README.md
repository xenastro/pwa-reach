# @xenastro/pwa-reach

[![npm](https://img.shields.io/npm/v/@xenastro/pwa-reach)](https://www.npmjs.com/package/@xenastro/pwa-reach)

Web push and install prompts for small, server-rendered PWAs. Built for apps
like Bun + Hono with HTML from the server and no build step, on Railway or
Cloudflare Workers.

- **Sender with no dependencies.** VAPID (RFC 8292) and `aes128gcm` encryption
  (RFC 8291) on WebCrypto. It's pinned to the RFC test vector and cross-checked
  against `web-push` in the tests. It runs on Bun, Node 20+, Deno and Workers.
- **Stores** for Postgres (Bun SQL or postgres.js) and Cloudflare D1, with
  idempotent schemas.
- **Hono routes**: service worker, page script, subscribe, receipts, renewals,
  tests, device removal, install reports.
- **Push-only service worker.** It has no fetch handler and no cache, so it
  never fights your app's freshness. It always shows a notification, confirms
  receipt to the server, and opens the right page on tap, including the fix for
  Android relaunching an installed app at its start URL.
- **Our own banner first.** The browser's permission prompt only appears after
  someone taps "Enable". "Not now" is remembered. The banner explains how to
  unblock notifications, gives iPhone "Add to Home Screen" steps, and spots
  in-app browsers (Telegram, WhatsApp, Instagram…). It also offers an Android
  install button.
- **Measuring.** Every notification is logged per device (accepted by the push
  service, received, opened), with a scorecard and ready-made HTML pieces for a
  settings page.

Notifications are for **signed-in users only**. Each device belongs to an
`owner` string that you choose, such as `"user:42"`.

## Install

```sh
bun add @xenastro/pwa-reach
npx @xenastro/pwa-reach vapid    # prints VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY for your .env
```

## Bun + Postgres + Hono

```ts
import { createReach, postgresStore } from "@xenastro/pwa-reach";
import { mountReach } from "@xenastro/pwa-reach/hono";
import { db } from "./db/client.ts"; // Bun SQL client (or a getter returning it)

export const reach = createReach({
  store: postgresStore(db),           // a client or a () => client getter
  vapid: { publicKey: Bun.env.VAPID_PUBLIC_KEY, privateKey: Bun.env.VAPID_PRIVATE_KEY, subject: Bun.env.VAPID_SUBJECT },
  appUrl: Bun.env.PUBLIC_URL!,        // absolute; tap links must be absolute for iOS
  appName: "Padel Trees",
  icon: "/icons/icon-192.png",
  badge: "/icons/badge-96.png",       // white glyph on transparent; without it Android shows a bell
  settingsPath: "/notifications",     // where a test notification's tap lands
  timeZone: "Asia/Amman",
});
await reach.store.migrate();          // on boot; idempotent

// BEFORE your auth guard:
mountReach(app, { reach, getOwner: async (c) => (await currentUser(c)) ? `user:${id}` : null });
```

In every page's `<head>`:

```ts
reach.headTags({ signedIn: !!user })   // inline stub + <script src="/reach/client.js?v=…" defer>
```

Send from anywhere. It never throws, and it logs every attempt:

```ts
await reach.send(
  { title: "Lineup locked 🔒", body: "Wed 9:00 PM · Court 3", path: `/games/${id}`, tag: `game-${id}`, kind: "lock", ref: `game:${id}` },
  ["user:3", "user:7"],                       // owners
  { filter: (device) => device.prefs !== "quiet" }, // optional, per-device prefs
);
```

## Cloudflare Workers + D1

```ts
import { createReach, d1Store } from "@xenastro/pwa-reach";
import { mountReach } from "@xenastro/pwa-reach/hono";

const reachFor = (env: Env) =>
  createReach({ store: d1Store(env.DB), vapid: { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT }, appUrl: env.PUBLIC_URL, appName: "…" });

mountReach(app, { reach: (c) => reachFor(c.env), getOwner: (c) => c.get("owner") });

// In a handler, don't await the send. Hand it to waitUntil so it outlives the response:
c.executionCtx.waitUntil(reachFor(c.env).send(message, owners));
```

Create the tables with `await store.migrate()` or by copying `d1Schema` into a
wrangler migration.

## Asking for permission

Never prompt on page load. Chrome switches to a quieter prompt for sites that
get refused often. Instead, offer at a moment that means something:

```html
<script>
  pwaReach.ready(function (R) {
    // e.g. right after a player answers an invitation:
    R.offer({ id: "rsvp", title: "Get notified when the lineup is locked?", snoozeDays: 14 });
  });
</script>
```

`offer()` shows nothing when notifications are already on or unsupported, and
nothing while snoozed. Otherwise it shows the right sheet for the device:

| state | what the person sees |
|---|---|
| `off` | your title/body with **Enable** / **Not now**. Enable runs the real browser prompt. |
| `ios-install` | iPhone Safari: Share → Add to Home Screen steps (iOS only allows push for Home Screen apps, which have their own sign-in) |
| `in-app` | "Open this in your browser" + Copy link (Telegram, WhatsApp, Instagram… in-app browsers can't install or push) |
| `denied` | how to unblock, per platform (only with `force: true`, e.g. on a settings page) |

`pwaReach.offerInstall({ ... })` does the same for installing: Android's
install prompt, iPhone steps, or the in-app message.

The full page API: `pushState()`, `enable()` (call it from a tap), `disable()`,
`subscription()`, `setPrefs(text)`, `test(true | endpoint)`, `installState()`,
`install()`, `offer()`, `offerInstall()`, `help(state)`, `snooze(id, days)`,
`unsnooze(id)`, `env()`, `on(fn)`, `synced()`. Use `ready(fn)` so your script
can't run before the client has loaded.

On every page load the client quietly re-checks this device's subscription
(right key, still there) and re-sends it to the server, which records "app
opened". It never prompts.

Texts are English by default. Override any of them for the whole app with
`createReach({ text: { offerTitle: "…" } })` (`{app}` is replaced with
`appName`), or per call: `offer({ text: { …any DEFAULT_TEXT key… } })`, which
also applies to `offerInstall()` and `help()`. That's how a player page can be
Arabic while the admin pages stay English.

Styling: the sheet and the settings pieces read `--pr-bg`, `--pr-ink`,
`--pr-accent`, `--pr-accent-ink`, `--pr-line`, `--pr-muted`, `--pr-good`,
`--pr-warn`, `--pr-bad`, `--pr-panel` and `--pr-bottom` (the sheet's distance
from the bottom, e.g. above a tab bar). Each falls back to a neutral default.

## Settings page pieces

```ts
import { uiCss, deviceCard, devicesTable, recentTable, scorecard, installsTable } from "@xenastro/pwa-reach";

const [devices, events, stats] = await Promise.all([reach.devices(owner), reach.recentEvents(30, owner), reach.stats()]);
`<style>${uiCss}</style>
 <section class="card"><h2>This device</h2>${deviceCard({ appName: "Padel Trees" })}</section>
 <section class="card"><h2>My devices</h2>${devicesTable(devices, { timeZone: "Asia/Amman" })}</section>
 <section class="card"><h2>Recent</h2>${recentTable(events, { timeZone: "Asia/Amman" })}</section>
 <section class="card"><h2>Scorecard</h2>${scorecard(stats)}</section>`
```

They're plain HTML strings. Pass them to your templating as raw HTML.

A scorecard in the terminal: `console.log(formatStats(await reach.stats(since)))`.

## Platform notes

- **iPhone/iPad**: push works only for an app added to the Home Screen (iOS
  16.4+). The installed app doesn't share Safari's cookies, so people sign in
  once inside it. iOS 18.4+ can show notifications from the payload alone
  (Declarative Web Push). This package sends that format, so the worker is a
  bonus there, not a requirement.
- **Android**: aggressive battery savers (Xiaomi, Oppo, Vivo, Huawei, Samsung)
  can delay pushes. Setting Chrome's battery usage to *Unrestricted* helps.
- **VAPID subject**: use `mailto:you@…` or your public https URL. Apple
  rejects `localhost`.
- **A service worker you already have**: add `importScripts('/reach/sw-push.js')`
  to it and pass its URL as `swPath`.

## Credits

The install-state and in-app-browser detection ideas are adapted from
[@baryodev/pwa-kit](https://github.com/BaryoDev/pwa-kit) (MIT).

MIT © xenastro
