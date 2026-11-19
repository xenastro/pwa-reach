// The service worker's push + tap handling, run against the real generated source.

import { test, expect } from "bun:test";
import { serviceWorkerScript } from "../src/sw.ts";

const SRC = serviceWorkerScript({ appName: "Trees", publicKey: "k", basePath: "/reach", icon: "/i.png", badge: "/b.png" });

function loadSw(clientsList: any[]) {
  const handlers: Record<string, (e: any) => void> = {};
  const opened: string[] = [];
  const shown: { title: string; opts: any }[] = [];
  const acks: string[] = [];
  const self = {
    location: { origin: "https://d.example" },
    addEventListener: (t: string, f: any) => {
      handlers[t] = f;
    },
    skipWaiting() {},
    clients: {
      matchAll: async () => clientsList,
      openWindow: async (u: string) => {
        opened.push(u);
        return null;
      },
      claim: async () => {},
    },
    registration: {
      showNotification: async (title: string, opts: any) => {
        shown.push({ title, opts });
      },
    },
  };
  const fetch = async (u: string) => {
    acks.push(u);
    return {};
  };
  new Function("self", "fetch", SRC)(self, fetch);
  const click = async (url: string) => {
    let p: Promise<any> = Promise.resolve();
    handlers.notificationclick!({ notification: { close() {}, data: { url } }, waitUntil: (x: any) => (p = x) });
    await p;
  };
  const push = async (data: unknown) => {
    let p: Promise<any> = Promise.resolve();
    const event = {
      data: data === undefined ? null : { json: () => (typeof data === "string" ? JSON.parse(data) : data), text: () => String(data) },
      waitUntil: (x: any) => (p = x),
    };
    handlers.push!(event);
    await p;
  };
  const ask = (path: string) => {
    let reply: any;
    handlers.message!({ data: { type: "pwa-reach-pending", path }, source: { postMessage: (m: any) => (reply = m) } });
    return reply.url as string | null;
  };
  return { click, push, ask, opened, shown, acks };
}

test("push: shows the payload's notification with icon + badge, then acks the delivery", async () => {
  const sw = loadSw([]);
  await sw.push({ notification: { title: "Locked", body: "يا شجرة", navigate: "https://d.example/e/1?via=push&d=tok", tag: "e1", dir: "auto" }, reach: { d: "tok" } });
  expect(sw.shown[0]!.title).toBe("Locked");
  expect(sw.shown[0]!.opts).toMatchObject({ body: "يا شجرة", tag: "e1", renotify: true, icon: "/i.png", badge: "/b.png", data: { url: "https://d.example/e/1?via=push&d=tok", d: "tok" } });
  expect(sw.acks).toEqual(["/reach/ack/tok"]);
});

test("push: an unreadable payload still shows a notification (iOS revokes silent pushes)", async () => {
  const sw = loadSw([]);
  await sw.push("not json");
  expect(sw.shown[0]!.title).toBe("Trees");
  expect(sw.acks).toEqual([]);
});

test("tap: backgrounded app → openWindow(url), never focus+navigate", async () => {
  let navigated = false;
  const sw = loadSw([{ visibilityState: "hidden", focus: async () => {}, navigate: async () => (navigated = true) }]);
  await sw.click("https://d.example/tx/1?via=push&d=t");
  expect(sw.opened).toEqual(["https://d.example/tx/1?via=push&d=t"]);
  expect(navigated).toBe(false);
});

test("tap: a visible window is navigated in place", async () => {
  const nav: string[] = [];
  const sw = loadSw([{ visibilityState: "visible", navigate: async (u: string) => (nav.push(u), { focus: async () => {} }) }]);
  await sw.click("https://d.example/tx/1");
  expect(nav).toEqual(["https://d.example/tx/1"]);
  expect(sw.opened).toEqual([]);
});

test("tap: a URL on another host of the same app stays on this worker's origin", async () => {
  const sw = loadSw([]);
  await sw.click("https://old-host.example/e/2?via=push&d=t");
  expect(sw.opened).toEqual(["https://d.example/e/2?via=push&d=t"]);
});

test("tap backstop: a start_url relaunch right after landing is redirected once", async () => {
  const sw = loadSw([]);
  await sw.click("https://d.example/tx/1?via=push&d=t");
  expect(sw.ask("/tx/1")).toBeNull(); // landed
  expect(sw.ask("/add")).toBe("https://d.example/tx/1?via=push&d=t"); // the 28ms race
  expect(sw.ask("/tx/1")).toBeNull();
  expect(sw.ask("/add")).toBeNull(); // once only: no loops
});

test("tap backstop: no tap → never redirects", () => {
  expect(loadSw([]).ask("/add")).toBeNull();
});
