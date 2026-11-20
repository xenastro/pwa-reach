# Changelog

## 0.2.0 (2026-11-20)

For single-page apps and pages under a strict CSP (first used by the radaideh
family tree, on Cloudflare Workers + D1):

- `GET {base}/stub.js` (`reach.stubScript()`): the stub as a file, since
  `script-src 'self'` blocks the inline one. It loads the versioned client and
  is revalidated with an ETag.
- `setSignedIn(bool)` for apps that sign in without reloading (the stub file
  starts "unknown" and waits for it), and `forget()` before signing out, so a
  shared phone stops getting the previous account's notifications.
- A notification tap is reported by the page itself (`POST {base}/opened/:id`)
  and the `via`/`d` parameters are removed from the address bar: pages served
  as static files never passed the server's `?via=push` middleware.
- Install state `manual`: Android without an install prompt (Samsung Internet,
  Firefox, Chrome before it decides) now gets the browser menu's steps instead
  of nothing. New texts `manualTitle`, `manualStep1..3`. `install({ text })`.
- `mountReach({ prefix })` for a Hono app with its own `basePath`.
- Tests for the page script.

## 0.1.1 (2026-11-19)

- `deviceCard`: enabling no longer sends a test notification by itself. Tapping
  "Send me a test" right after enabling delivered two (reported in padel_trees).
- README: npm badge.

## 0.1.0 (2026-11-19)

First release, extracted from daftar's web push pilot (live since 2026-11-18):
the WebCrypto sender, the push-only service worker (with the Android tap fix and
receipt acks), the per-device delivery log and scorecard. Added Hono routes,
Postgres and D1 stores, the permission/install banner, iPhone and in-app-browser
guidance, install reporting, and the settings-page pieces. Per-call text
overrides (`offer({ text })`) for pages in another language. The client's
subscribe step is single-flight: an Enable tap during the on-open check no
longer creates two subscriptions (seen in a real Chrome + FCM end-to-end run).
