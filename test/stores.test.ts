// The ReachStore contract, run against both shipped stores: D1 (via a
// bun:sqlite stand-in) and Postgres (Bun SQL, when a local server is up).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { SQL } from "bun";
import { d1Store } from "../src/d1.ts";
import { postgresStore } from "../src/postgres.ts";
import type { ReachStore } from "../src/types.ts";
import { fakeD1 } from "./fake-d1.ts";
import { testPostgres } from "./pg.ts";

const key = (n: number) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`,
  p256dh: "B".padEnd(87, "x"),
  auth: "a".padEnd(22, "y"),
});
const did = (n: number) => `delivery-token-${String(n).padStart(6, "0")}`;

function contract(name: string, make: () => Promise<ReachStore | null>) {
  describe(name, () => {
    let s: ReachStore;
    let skip = false;
    beforeAll(async () => {
      const store = await make();
      if (!store) {
        skip = true;
        return;
      }
      s = store;
      await s.migrate();
      await s.migrate(); // idempotent
    });
    const t = (title: string, fn: () => Promise<void>) => test(title, async () => (skip ? undefined : fn()));

    t("upsert creates, re-upsert refreshes and can change owner", async () => {
      const a = await s.upsertSubscription("user:1", key(1), "android", "UA1");
      expect(a).toMatchObject({ owner: "user:1", platform: "android", userAgent: "UA1", prefs: null, failCount: 0 });
      expect(a.createdAt).toBeInstanceOf(Date);
      const b = await s.upsertSubscription("user:2", key(1), "android", "UA2");
      expect(b.id).toBe(a.id);
      expect(b.owner).toBe("user:2");
      await s.upsertSubscription("user:1", key(1), "android", "UA1");
      await s.upsertSubscription("user:1", key(2), "ios", null);
      await s.upsertSubscription("user:3", key(3), "desktop", null);
      expect((await s.subscriptionsFor(["user:1"])).map((x) => x.endpoint).sort()).toEqual([key(1).endpoint, key(2).endpoint]);
      expect((await s.subscriptionsFor(["user:1", "user:3"])).length).toBe(3);
      expect(await s.subscriptionsFor([])).toEqual([]);
      expect(await s.subscriptionsFor(["nobody"])).toEqual([]);
    });

    t("prefs and deletes only touch the owner's rows", async () => {
      expect(await s.setPrefs(key(1).endpoint, "user:3", "action")).toBe(false);
      expect(await s.setPrefs(key(1).endpoint, "user:1", "action")).toBe(true);
      expect((await s.subscriptionsFor(["user:1"])).find((x) => x.endpoint === key(1).endpoint)!.prefs).toBe("action");
      expect(await s.deleteSubscriptionByEndpoint(key(3).endpoint, "user:1")).toBe(false);
      const three = (await s.subscriptionsFor(["user:3"]))[0]!;
      expect(await s.deleteSubscription(three.id, "user:1")).toBe(false);
      expect(await s.deleteSubscription(three.id, "user:3")).toBe(true);
      expect(await s.subscriptionsFor(["user:3"])).toEqual([]);
    });

    t("renew moves the row (keeps prefs), unknown old endpoint → false", async () => {
      expect(await s.renewSubscription("https://nope.example/x", key(9))).toBe(false);
      expect(await s.renewSubscription(key(1).endpoint, key(4))).toBe(true);
      const rows = await s.subscriptionsFor(["user:1"]);
      expect(rows.map((x) => x.endpoint).sort()).toEqual([key(2).endpoint, key(4).endpoint]);
      expect(rows.find((x) => x.endpoint === key(4).endpoint)!.prefs).toBe("action");
    });

    t("events, deliveries, send results, receipts, opens", async () => {
      const [s4, s2] = [key(4), key(2)].map((k) => k.endpoint);
      const subs = await s.subscriptionsFor(["user:1"]);
      const sub4 = subs.find((x) => x.endpoint === s4)!;
      const sub2 = subs.find((x) => x.endpoint === s2)!;
      const ev = await s.insertEvent({ kind: "info", ref: "event:7", title: "Lineup locked", body: "يا شجرة", url: "/e/7", audience: ["user:1", "user:5"], devices: 2 });
      expect(ev).toBeGreaterThan(0);
      await s.insertDelivery({ id: did(1), eventId: ev, subscriptionId: sub4.id, owner: "user:1", platform: "android" });
      await s.insertDelivery({ id: did(2), eventId: ev, subscriptionId: sub2.id, owner: "user:1", platform: "ios" });
      await s.recordSendResult(did(1), sub4.id, { status: 201, ok: true, gone: false });
      await s.recordSendResult(did(2), sub2.id, { status: 500, ok: false, gone: false, error: "boom" });
      let rows = await s.subscriptionsFor(["user:1"]);
      expect(rows.find((x) => x.id === sub4.id)!.lastSentAt).toBeInstanceOf(Date);
      expect(rows.find((x) => x.id === sub2.id)!).toMatchObject({ failCount: 1, lastError: "500: boom" });

      expect(await s.markReceived("bad id!")).toBe(false);
      expect(await s.markReceived(did(1))).toBe(true);
      expect(await s.markReceived(did(1))).toBe(false); // first wins
      rows = await s.subscriptionsFor(["user:1"]);
      expect(rows.find((x) => x.id === sub4.id)!.lastDeliveredAt).toBeInstanceOf(Date);
      await s.markOpened(did(2)); // a tap also proves receipt

      const [log] = await s.recentEvents(10);
      expect(log).toMatchObject({ id: ev, kind: "info", ref: "event:7", title: "Lineup locked", body: "يا شجرة", audience: ["user:1", "user:5"], devices: 2 });
      const d2 = log!.deliveries.find((x) => x.platform === "ios")!;
      expect(d2.openedAt).toBeInstanceOf(Date);
      expect(d2.receivedAt).toBeInstanceOf(Date);
      expect(d2).toMatchObject({ pushStatus: 500, error: "boom", owner: "user:1" });

      // 410 deletes the subscription; the delivery survives with its snapshot.
      await s.recordSendResult(did(2), sub2.id, { status: 410, ok: false, gone: true, error: "expired" });
      expect((await s.subscriptionsFor(["user:1"])).map((x) => x.id)).toEqual([sub4.id]);
      expect((await s.recentEvents(1))[0]!.deliveries.length).toBe(2);
    });

    t("recentEvents(owner) shows only that owner's events and deliveries; activity skips tests", async () => {
      const sub4 = (await s.subscriptionsFor(["user:1"]))[0]!;
      await s.upsertSubscription("user_5", key(5), "android", null); // "_" must not act as a LIKE wildcard
      const t1 = await s.insertEvent({ kind: "test", ref: null, title: "test", body: "", url: "/", audience: ["user:1"], devices: 1 });
      await s.insertDelivery({ id: did(3), eventId: t1, subscriptionId: sub4.id, owner: "user:1", platform: "android" });
      await s.insertEvent({ kind: "info", ref: null, title: "for user_5", body: "", url: "/", audience: ["user_5"], devices: 0 });
      const mine = await s.recentEvents(10, "user:1");
      expect(mine.map((e) => e.title)).toEqual(["test", "Lineup locked"]);
      expect(mine[1]!.deliveries.every((x) => x.owner === "user:1")).toBe(true);
      expect((await s.recentEvents(10, "user:5")).map((e) => e.title)).toEqual(["Lineup locked"]);
      expect((await s.recentEvents(10, "user_5")).map((e) => e.title)).toEqual(["for user_5"]);
      expect((await s.recentEvents(10, "user%")).length).toBe(0);

      const a = await s.activity(new Date(Date.now() - 3600_000));
      expect(a.events.map((e) => e.title).sort()).toEqual(["Lineup locked", "for user_5"]);
      expect(a.deliveries.length).toBe(2);
      expect(await s.firstEventAt()).toBeInstanceOf(Date);
      expect((await s.activity(new Date(Date.now() + 3600_000))).events).toEqual([]);
    });

    t("install reports upsert and keep the first install time", async () => {
      const base = { owner: null, platform: "android" as const, displayMode: "browser" as const, installed: false, inApp: null, userAgent: "UA" };
      await s.reportInstall({ ...base, deviceId: "a".repeat(32) });
      await s.reportInstall({ ...base, deviceId: "a".repeat(32), owner: "user:1", displayMode: "standalone", installed: true });
      await s.reportInstall({ ...base, deviceId: "a".repeat(32), displayMode: "browser", installed: false }); // owner kept
      await s.reportInstall({ ...base, deviceId: "b".repeat(32), platform: "ios", inApp: "Telegram" });
      const sum = await s.installSummary();
      expect(sum.find((r) => r.platform === "android")).toEqual({ platform: "android", devices: 1, installed: 1, inApp: 0 });
      expect(sum.find((r) => r.platform === "ios")).toEqual({ platform: "ios", devices: 1, installed: 0, inApp: 1 });
    });
  });
}

contract("d1Store (bun:sqlite)", async () => d1Store(fakeD1()));

let pg: SQL | null = null;
contract("postgresStore (Bun SQL)", async () => {
  pg = await testPostgres();
  return pg ? postgresStore(() => pg!) : null;
});
afterAll(async () => {
  await pg?.end();
});
