# Changelog

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
