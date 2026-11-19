// Hono routes. Mount BEFORE your auth guard: the worker, the client script,
// receipts, renewals and install reports are public; the rest check
// `getOwner(c)` themselves and answer 401 JSON when nobody is signed in.
//
//   GET  {swPath}                    the service worker (default /sw.js)
//   GET  {base}/client.js            page script (cache-busted by headTags)
//   GET  {base}/sw-push.js           push handlers only, for importScripts
//   POST {base}/ack/:id              service-worker receipt (id = random delivery token)
//   POST {base}/renew                pushsubscriptionchange (authorised by the old endpoint)
//   POST {base}/install              daily install report
//   POST {base}/subscribe            owner: enable / on-open re-send
//   POST {base}/unsubscribe          owner: turn this device off
//   POST {base}/prefs                owner: this device's prefs
//   POST {base}/test                 owner: test to one or all of my devices
//   POST {base}/devices/:id/delete   owner: remove one of my devices
//   GET  *?via=push&d=<id>           tap-through → opened_at (middleware, never blocks)

import type { Context, Hono } from "hono";
import type { Reach } from "./core.js";
import { platformOf } from "./core.js";
import type { Platform } from "./types.js";

export interface MountOptions {
  /** The Reach instance, or a per-request factory (Workers: build it from c.env). */
  reach: Reach | ((c: Context) => Reach);
  /** The signed-in user's owner key (e.g. "user:42"), or null. */
  getOwner: (c: Context) => string | null | undefined | Promise<string | null | undefined>;
  /** Only needed with a factory: must match the factory's config. Defaults "/reach" and "/sw.js". */
  basePath?: string;
  swPath?: string;
}

const PLATFORMS: Platform[] = ["android", "ios", "desktop", "other"];

interface SubJson {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
}

/** Validate a PushSubscription.toJSON(). Every real push service is https. */
export function parseSubscription(v: unknown): { endpoint: string; p256dh: string; auth: string } | null {
  const s = (v ?? {}) as SubJson;
  const endpoint = typeof s.endpoint === "string" ? s.endpoint : "";
  const p256dh = typeof s.keys?.p256dh === "string" ? s.keys.p256dh : "";
  const auth = typeof s.keys?.auth === "string" ? s.keys.auth : "";
  if (!/^https:\/\/[^\s]{8,2000}$/.test(endpoint)) return null;
  if (!/^[A-Za-z0-9_-]{80,100}={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}={0,2}$/.test(auth)) return null;
  return { endpoint, p256dh: p256dh.replace(/=+$/, ""), auth: auth.replace(/=+$/, "") };
}

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    return ((await c.req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Run after the response. Uses waitUntil on Workers; elsewhere just lets it run. */
export function background(c: Context, p: Promise<unknown>): void {
  const safe = p.catch((e) => console.error("[pwa-reach]", e instanceof Error ? e.message : e));
  try {
    c.executionCtx.waitUntil(safe);
  } catch {
    // Bun/Node: no execution context; the promise runs on its own.
  }
}

export function mountReach(app: Hono<any, any, any>, opts: MountOptions): void {
  const get = (c: Context): Reach => (typeof opts.reach === "function" ? opts.reach(c) : opts.reach);
  const probe = typeof opts.reach === "function" ? null : opts.reach;
  const base = probe?.config.basePath ?? (opts.basePath ?? "/reach").replace(/\/+$/, "");
  const swPath = probe?.config.swPath ?? opts.swPath ?? "/sw.js";
  const owner = async (c: Context) => (await opts.getOwner(c)) || null;
  const signedOut = (c: Context) => c.json({ ok: false, error: "signed out" }, 401);

  app.use("*", async (c, next) => {
    if (c.req.method === "GET" && c.req.query("via") === "push") {
      const d = c.req.query("d");
      if (d) background(c, get(c).store.markOpened(d));
    }
    return next();
  });

  app.get(swPath, (c) => {
    c.header("content-type", "text/javascript; charset=utf-8");
    c.header("cache-control", "no-cache"); // always revalidate: worker updates land on next open
    c.header("service-worker-allowed", "/");
    return c.body(get(c).serviceWorker());
  });

  app.get(`${base}/client.js`, (c) => {
    c.header("content-type", "text/javascript; charset=utf-8");
    // headTags() adds ?v=<hash of the script>, so a changed script gets a new URL.
    c.header("cache-control", c.req.query("v") ? "public, max-age=31536000, immutable" : "no-cache");
    return c.body(get(c).clientScript());
  });

  app.get(`${base}/sw-push.js`, (c) => {
    c.header("content-type", "text/javascript; charset=utf-8");
    c.header("cache-control", "no-cache");
    return c.body(get(c).pushWorker());
  });

  app.post(`${base}/ack/:id`, async (c) => {
    await get(c).store.markReceived(c.req.param("id")!).catch((e) => console.error("[pwa-reach] ack failed:", e));
    return c.json({ ok: true });
  });

  app.post(`${base}/renew`, async (c) => {
    const b = await body(c);
    const sub = parseSubscription(b.subscription);
    const old = typeof b.oldEndpoint === "string" ? b.oldEndpoint : null;
    if (!sub || !old) return c.json({ ok: false }, 400);
    const ok = await get(c).store.renewSubscription(old, sub).catch(() => false);
    return c.json({ ok }, ok ? 200 : 404);
  });

  app.post(`${base}/install`, async (c) => {
    const b = await body(c);
    const deviceId = typeof b.deviceId === "string" && /^[a-f0-9]{32}$/.test(b.deviceId) ? b.deviceId : null;
    if (!deviceId) return c.json({ ok: false }, 400);
    const ua = c.req.header("user-agent") ?? null;
    const platform = PLATFORMS.includes(b.platform as Platform) ? (b.platform as Platform) : platformOf(ua);
    const who = await Promise.resolve(owner(c)).catch(() => null);
    await get(c).store.reportInstall({
      deviceId,
      owner: who,
      platform,
      displayMode: b.displayMode === "standalone" ? "standalone" : "browser",
      installed: b.installed === true,
      inApp: typeof b.inApp === "string" ? b.inApp.slice(0, 40) : null,
      userAgent: ua ? ua.slice(0, 400) : null,
    });
    return c.json({ ok: true });
  });

  app.post(`${base}/subscribe`, async (c) => {
    const r = get(c);
    const who = await owner(c);
    if (!who) return signedOut(c);
    if (!r.configured) return c.json({ ok: false, error: "push not configured (VAPID keys unset)" }, 503);
    const b = await body(c);
    const sub = parseSubscription(b.subscription);
    if (!sub) return c.json({ ok: false, error: "bad subscription" }, 400);
    const ua = c.req.header("user-agent") ?? null;
    const platform = PLATFORMS.includes(b.platform as Platform) ? (b.platform as Platform) : platformOf(ua);
    const row = await r.store.upsertSubscription(who, sub, platform, ua ? ua.slice(0, 400) : null);
    return c.json({ ok: true, id: row.id, prefs: row.prefs });
  });

  app.post(`${base}/unsubscribe`, async (c) => {
    const who = await owner(c);
    if (!who) return signedOut(c);
    const b = await body(c);
    if (typeof b.endpoint === "string") await get(c).store.deleteSubscriptionByEndpoint(b.endpoint, who);
    return c.json({ ok: true });
  });

  app.post(`${base}/prefs`, async (c) => {
    const who = await owner(c);
    if (!who) return signedOut(c);
    const b = await body(c);
    if (typeof b.endpoint !== "string") return c.json({ ok: false, error: "bad request" }, 400);
    const prefs = typeof b.prefs === "string" ? b.prefs.slice(0, 200) : null;
    const ok = await get(c).store.setPrefs(b.endpoint, who, prefs);
    return c.json({ ok }, ok ? 200 : 404);
  });

  app.post(`${base}/test`, async (c) => {
    const r = get(c);
    const who = await owner(c);
    if (!who) return signedOut(c);
    if (!r.configured) return c.json({ ok: false, error: "push not configured (VAPID keys unset)" }, 503);
    const b = await body(c);
    const res = await r.sendTest(who, typeof b.endpoint === "string" ? b.endpoint : undefined);
    if (!res.devices) return c.json({ ok: false, error: "no device has notifications on" });
    return c.json({ ok: res.accepted > 0, ...res });
  });

  app.post(`${base}/devices/:id/delete`, async (c) => {
    const who = await owner(c);
    if (!who) return signedOut(c);
    const id = Number(c.req.param("id"));
    const ok = Number.isFinite(id) ? await get(c).store.deleteSubscription(id, who) : false;
    return c.json({ ok });
  });
}
