// createReach + Hono routes + generated scripts, on the D1 stand-in with a fake push service.

import { test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createReach, buildPayload, tapUrl, checkSubject, computeStats, formatStats, type Reach } from "../src/core.ts";
import { mountReach, parseSubscription } from "../src/hono.ts";
import { d1Store } from "../src/d1.ts";
import { generateVapidKeys } from "../src/webpush.ts";
import { deviceCard, devicesTable, scorecard, recentTable, installsTable } from "../src/ui.ts";
import { fakeD1 } from "./fake-d1.ts";

const RFC_P256DH = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const RFC_AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/d${n}`, keys: { p256dh: RFC_P256DH, auth: RFC_AUTH } });

const vapid = { ...(await generateVapidKeys()), subject: "mailto:ops@example.com" };
let pushStatus = 201;
let pushed: { url: string; headers: Record<string, string> }[] = [];
const fakeFetch = (async (url: string, init: RequestInit) => {
  pushed.push({ url, headers: init.headers as Record<string, string> });
  return new Response(pushStatus === 201 ? null : "gone", { status: pushStatus });
}) as unknown as typeof fetch;

let reach: Reach;
let d1: ReturnType<typeof fakeD1>;
let app: Hono;
let who: string | null = "user:1";

beforeEach(async () => {
  pushStatus = 201;
  pushed = [];
  who = "user:1";
  d1 = fakeD1();
  const store = d1Store(d1);
  await store.migrate();
  reach = createReach({ store, vapid, appUrl: "https://app.example.com/", appName: "Trees", badge: "/icons/badge.png", fetch: fakeFetch, timeZone: "Asia/Amman" });
  app = new Hono();
  mountReach(app, { reach, getOwner: () => who });
  app.get("/e/:id", (c) => c.text("event page"));
});

const post = (path: string, body: unknown, ua = "Mozilla/5.0 (Linux; Android 14) Chrome/130") =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", "user-agent": ua }, body: JSON.stringify(body) });

test("payload is Declarative Web Push with an absolute tap URL carrying the delivery id", () => {
  const p = JSON.parse(buildPayload({ title: "Locked", body: "يا شجرة", path: "/e/7", tag: "e7" }, "tok", { appUrl: "https://app.example.com", nowMs: 5 }));
  expect(p).toEqual({
    web_push: 8030,
    notification: { title: "Locked", body: "يا شجرة", navigate: "https://app.example.com/e/7?via=push&d=tok", tag: "e7", lang: "en", dir: "auto", silent: false, timestamp: 5 },
    mutable: true,
    reach: { d: "tok", kind: "info" },
  });
  expect(tapUrl("https://a.example/", "/x?y=1", "d1")).toBe("https://a.example/x?y=1&via=push&d=d1");
});

test("VAPID subject check flags what Apple rejects", () => {
  expect(checkSubject("mailto:a@b.co")).toBeNull();
  expect(checkSubject("https://padeltrees.radrek.com")).toBeNull();
  expect(checkSubject("https://localhost")).toContain("Apple");
  expect(checkSubject("http://x.example")).toContain("https");
});

test("subscribe needs an owner, validates, and upserts with the client's platform hint", async () => {
  who = null;
  expect((await post("/reach/subscribe", { subscription: sub(1) })).status).toBe(401);
  who = "user:1";
  expect((await post("/reach/subscribe", { subscription: { endpoint: "http://x" } })).status).toBe(400);
  const r = await post("/reach/subscribe", { subscription: sub(1), platform: "ios" }, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari");
  expect(await r.json()).toMatchObject({ ok: true, prefs: null });
  const [d] = await reach.devices("user:1");
  expect(d).toMatchObject({ platform: "ios", owner: "user:1" }); // iPadOS reports "Macintosh"; the hint wins
  expect(parseSubscription(sub(2))).toEqual({ endpoint: sub(2).endpoint, p256dh: RFC_P256DH, auth: RFC_AUTH });
});

test("send: event + one delivery per device, receipt ack, tap-through, 410 removes the device", async () => {
  await post("/reach/subscribe", { subscription: sub(1) });
  await post("/reach/subscribe", { subscription: sub(2) });
  who = "user:2";
  await post("/reach/subscribe", { subscription: sub(3) });

  const r = await reach.send({ title: "Lineup locked", body: "Wed 9 PM", path: "/e/7", kind: "lock", ref: "event:7" }, ["user:1", "user:9"]);
  expect(r).toMatchObject({ devices: 2, accepted: 2 });
  expect(pushed.length).toBe(2);
  expect(pushed[0]!.headers.Authorization).toStartWith("vapid t=");
  const [ev] = await reach.recentEvents(5);
  expect(ev).toMatchObject({ kind: "lock", ref: "event:7", audience: ["user:1", "user:9"], devices: 2 });

  const rows = await reach.store.recentEvents(1);
  expect(rows[0]!.deliveries.map((d) => d.pushStatus)).toEqual([201, 201]);

  // Filter by prefs.
  pushed = [];
  who = "user:1";
  await post("/reach/prefs", { endpoint: sub(1).endpoint, prefs: "action" });
  const f = await reach.send({ title: "info only", path: "/" }, ["user:1"], { filter: (s) => s.prefs !== "action" });
  expect(f.devices).toBe(1);

  // 410 → the subscription is deleted.
  pushStatus = 410;
  const g = await reach.send({ title: "x", path: "/" }, ["user:2"]);
  expect(g.results[0]).toMatchObject({ status: 410, gone: true });
  expect(await reach.devices("user:2")).toEqual([]);
});

test("ack + tap-through stamp the delivery; stats count them", async () => {
  await post("/reach/subscribe", { subscription: sub(1) });
  await post("/reach/subscribe", { subscription: sub(2) });
  await reach.send({ title: "hello", path: "/e/1" }, ["user:1"]);
  const ids = (await d1.prepare("select id from reach_delivery order by id").all<{ id: string }>()).results.map((r) => r.id);
  expect(ids.length).toBe(2);

  who = null; // the worker has no session
  expect((await post(`/reach/ack/${ids[0]}`, {})).status).toBe(200);
  expect((await post("/reach/ack/unknown-token-000000", {})).status).toBe(200); // silent no-op
  const page = await app.request(`/e/1?via=push&d=${ids[1]}`);
  expect(await page.text()).toBe("event page"); // never blocks the page
  await Bun.sleep(10); // the open is stamped in the background

  const s = await reach.stats();
  expect(s).toMatchObject({ events: 1, deliveries: 2, accepted: 2, received: 2, opened: 1 });
  expect(s.unconfirmed).toEqual([]);
  expect(s.latency).not.toBeNull();
  expect(formatStats(s)).toContain("notifications decided      1");
  expect((await reach.devices("user:1")).filter((d) => d.lastDeliveredAt).length).toBe(1); // the tap doesn't stamp the device
});

test("computeStats: rates, latency percentiles, misses", () => {
  const t0 = new Date("2026-11-19T10:00:00Z");
  const at = (s: number) => new Date(t0.getTime() + s * 1000);
  const s = computeStats(
    {
      events: [
        { id: 1, kind: "info", title: "a", devices: 2, createdAt: t0 },
        { id: 2, kind: "info", title: "b", devices: 0, createdAt: t0 },
      ],
      deliveries: [
        { eventId: 1, owner: "u", platform: "android", sentAt: t0, pushStatus: 201, error: null, receivedAt: at(2), openedAt: at(9) },
        { eventId: 1, owner: "u", platform: "ios", sentAt: t0, pushStatus: 201, error: null, receivedAt: null, openedAt: null },
      ],
    },
    t0,
  );
  expect(s).toMatchObject({ events: 2, eventsNoDevice: 1, eventsReached: 1, deliveries: 2, accepted: 2, received: 1, opened: 1, failed: 0 });
  expect(s.latency).toEqual({ p50: 2, p90: 2, max: 2 });
  expect(s.unconfirmed).toEqual([{ at: t0, title: "a", platform: "ios", status: 201, error: null }]);
});

test("test push, unsubscribe, device delete are owner-scoped", async () => {
  await post("/reach/subscribe", { subscription: sub(1) });
  const t = await (await post("/reach/test", {})).json();
  expect(t).toMatchObject({ ok: true, devices: 1, accepted: 1 });
  const [ev] = await reach.recentEvents(1);
  expect(ev!.kind).toBe("test");
  expect((await reach.stats()).events).toBe(0); // tests excluded

  const [d] = await reach.devices("user:1");
  who = "user:2";
  expect(await (await post(`/reach/devices/${d!.id}/delete`, {})).json()).toEqual({ ok: false });
  await post("/reach/unsubscribe", { endpoint: sub(1).endpoint });
  expect((await reach.devices("user:1")).length).toBe(1);
  who = "user:1";
  expect(await (await post(`/reach/devices/${d!.id}/delete`, {})).json()).toEqual({ ok: true });
  expect(await (await post("/reach/test", {})).json()).toMatchObject({ ok: false, error: "no device has notifications on" });
});

test("renew moves the row; install reports are public and validated", async () => {
  await post("/reach/subscribe", { subscription: sub(1) });
  who = null;
  expect((await post("/reach/renew", { oldEndpoint: sub(1).endpoint, subscription: sub(5) })).status).toBe(200);
  expect((await reach.devices("user:1"))[0]!.endpoint).toBe(sub(5).endpoint);
  expect((await post("/reach/renew", { oldEndpoint: "https://nope.example/x", subscription: sub(6) })).status).toBe(404);

  expect((await post("/reach/install", { deviceId: "short" })).status).toBe(400);
  expect((await post("/reach/install", { deviceId: "a".repeat(32), displayMode: "standalone", installed: true, platform: "android", inApp: null })).status).toBe(200);
  expect(await reach.installs()).toEqual([{ platform: "android", devices: 1, installed: 1, inApp: 0 }]);
});

test("worker + client scripts are served, valid JS, and carry the config", async () => {
  const sw = await app.request("/sw.js");
  expect(sw.headers.get("service-worker-allowed")).toBe("/");
  const swText = await sw.text();
  expect(() => new Function(swText)).not.toThrow();
  expect(swText).toContain(vapid.publicKey);
  expect(swText).toContain("/icons/badge.png");
  expect(swText).toContain("c.visibilityState === 'visible'"); // the Android tap fix
  const push = await (await app.request("/reach/sw-push.js")).text();
  expect(() => new Function(push)).not.toThrow();
  expect(push).not.toContain("skipWaiting");

  const tags = reach.headTags({ signedIn: true });
  const src = /src="([^"]+)"/.exec(tags)![1]!;
  const client = await app.request(src);
  expect(client.headers.get("cache-control")).toContain("immutable");
  const js = await client.text();
  expect(() => new Function(js)).not.toThrow();
  expect(js).toContain('"app":"Trees"');
  expect(() => new Function(/<script>([\s\S]*?)<\/script>/.exec(tags)![1]!)).not.toThrow();
  expect(tags).toContain("r.signedIn=true");
});

test("ui pieces render escaped HTML with valid inline scripts", async () => {
  await post("/reach/subscribe", { subscription: sub(1) });
  await reach.send({ title: "<b>x</b>", body: "يا شجرة", path: "/e/1" }, ["user:1"]);
  const parts = [
    deviceCard({ appName: "Trees", prefs: [{ value: "all", label: "Everything" }, { value: "action", label: "Only what needs me" }] }),
    devicesTable(await reach.devices("user:1"), { timeZone: "Asia/Amman", prefsLabel: (p) => p ?? "everything" }),
    scorecard(await reach.stats()),
    recentTable(await reach.recentEvents(5), { ownerLabel: (o) => o ?? "?" }),
    installsTable([{ platform: "ios", devices: 2, installed: 1, inApp: 1 }]),
  ];
  const html = parts.join("\n");
  expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  expect(html).not.toContain("<b>x</b>");
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new Function(m[1]!)).not.toThrow();
});
