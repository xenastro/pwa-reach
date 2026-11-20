// The page script and the stub file, run against the real generated source in
// a small fake browser (no DOM library: the client only needs a few calls).

import { test, expect } from "bun:test";
import { clientScript, stubScript, DEFAULT_TEXT } from "../src/client.ts";
import { generateVapidKeys } from "../src/webpush.ts";

const { publicKey } = await generateVapidKeys();
const KEY_BYTES = new Uint8Array(Buffer.from(publicKey, "base64url"));
const SRC = clientScript({ appName: "Trees", publicKey, basePath: "/api/reach", swPath: "/api/reach/sw.js", text: DEFAULT_TEXT, installReport: false });

const UA = {
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  desktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
};

class El {
  children: El[] = [];
  parent: El | null = null;
  className = "";
  textContent = "";
  attrs: Record<string, string> = {};
  [k: string]: any;
  constructor(public tag: string) {}
  appendChild(c: El) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
}
const all = (e: El): El[] => [e, ...e.children.flatMap(all)];
const textOf = (e: El): string => all(e).map((x) => x.textContent).filter(Boolean).join(" | ");

interface Opts {
  ua?: string;
  href?: string;
  stub?: Record<string, unknown>;
  permission?: NotificationPermission;
  subscribed?: boolean;
}

function browser(o: Opts = {}) {
  const posts: { url: string; body: any }[] = [];
  const replaced: string[] = [];
  const store = new Map<string, string>();
  const head = new El("head");
  const body = new El("body");
  let sub: any = null;
  const makeSub = (endpoint: string) => ({
    endpoint,
    options: { applicationServerKey: KEY_BYTES.buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: async () => {
      sub = null;
      return true;
    },
  });
  if (o.subscribed) sub = makeSub("https://push.example/old");
  const reg = {
    pushManager: {
      getSubscription: async () => sub,
      subscribe: async () => (sub = makeSub("https://push.example/new")),
    },
  };
  const win: any = {
    pwaReach: o.stub ? { q: [], ...o.stub } : undefined,
    PushManager: function () {},
    addEventListener() {},
    history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
  };
  const nav: any = {
    userAgent: o.ua ?? UA.android,
    maxTouchPoints: 5,
    serviceWorker: {
      controller: null,
      register: async () => reg,
      ready: Promise.resolve(reg),
      getRegistration: async () => reg,
    },
  };
  const doc: any = {
    head,
    body,
    createElement: (t: string) => new El(t),
    getElementById: (id: string) => all(head).find((e) => e.id === id) ?? null,
  };
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const fetch = async (url: string, init: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init.body ?? "{}")) });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const location = { href: o.href ?? "https://app.example/", pathname: new URL(o.href ?? "https://app.example/").pathname };
  const Notification = { permission: o.permission ?? "default" };
  win.Notification = Notification; // pushSupported() asks `"Notification" in window`
  const matchMedia = () => ({ matches: false });
  new Function("window", "document", "navigator", "localStorage", "matchMedia", "Notification", "location", "history", "fetch", SRC)(
    win, doc, nav, localStorage, matchMedia, Notification, location, win.history, fetch,
  );
  const R = win.pwaReach;
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const sheet = () => body.children[0] ?? null;
  return { R, win, posts, replaced, store, sheet, tick, sub: () => sub };
}

test("a notification tap: reports opened to the server and cleans the address bar", async () => {
  const b = browser({ href: "https://app.example/c/5?x=1&via=push&d=abc_123#top" });
  await b.tick();
  expect(b.posts.map((p) => p.url)).toContain("/api/reach/opened/abc_123");
  expect(b.replaced).toEqual(["/c/5?x=1#top"]);
});

test("no tap parameters: nothing reported, address untouched", async () => {
  const b = browser({ href: "https://app.example/c/5?x=1" });
  await b.tick();
  expect(b.posts.filter((p) => p.url.includes("/opened/"))).toHaveLength(0);
  expect(b.replaced).toHaveLength(0);
});

test("install states: Android with and without a prompt, iPhone, desktop", () => {
  expect(browser({ ua: UA.android }).R.installState()).toBe("manual");
  expect(browser({ ua: UA.android, stub: { bip: { prompt() {} } } }).R.installState()).toBe("prompt");
  expect(browser({ ua: UA.iphone }).R.installState()).toBe("ios-steps");
  expect(browser({ ua: UA.desktop }).R.installState()).toBe("unavailable");
});

test("offerInstall without a prompt on Android shows the menu steps, in the call's language; closing snoozes", async () => {
  const b = browser({ ua: UA.android });
  const st = await b.R.offerInstall({ id: "home", text: { manualTitle: "ثبّت {app}", manualStep1: "افتح القائمة" } });
  expect(st).toBe("manual");
  const t = textOf(b.sheet()!);
  expect(t).toContain("ثبّت Trees");
  expect(t).toContain("افتح القائمة");
  expect(t).toContain(DEFAULT_TEXT.manualStep2);
  all(b.sheet()!).find((e) => e.className.includes("pr-btn"))!.onclick();
  expect(b.sheet()).toBeNull();
  expect(await b.R.offerInstall({ id: "home" })).toBe("snoozed");
});

test("install() on Android without a prompt explains the menu steps", async () => {
  const b = browser({ ua: UA.android });
  expect(await b.R.install({ text: { manualTitle: "خطوات" } })).toBe("manual");
  expect(textOf(b.sheet()!)).toContain("خطوات");
});

test("signed-in state unknown (stub.js): no subscription check until the page says signed in", async () => {
  const b = browser({ stub: { signedIn: null }, permission: "granted", subscribed: true });
  await b.tick();
  expect(b.posts.filter((p) => p.url.endsWith("/subscribe"))).toHaveLength(0);
  b.R.setSignedIn(true);
  await b.R.synced();
  const subs = b.posts.filter((p) => p.url.endsWith("/subscribe"));
  expect(subs).toHaveLength(1);
  expect(subs[0]!.body.reason).toBe("signin");
  expect(b.R.signedIn).toBe(true);
});

test("a value given to the stub before the client loaded is kept", async () => {
  const b = browser({ stub: { signedIn: true }, permission: "granted", subscribed: true });
  await b.R.synced();
  expect(b.posts.filter((p) => p.url.endsWith("/subscribe"))[0]!.body.reason).toBe("open");
});

test("signed out: setSignedIn(true) without permission prompts nothing and subscribes nothing", async () => {
  const b = browser({ stub: { signedIn: null }, permission: "default" });
  b.R.setSignedIn(true);
  await b.tick();
  expect(b.posts.filter((p) => p.url.endsWith("/subscribe"))).toHaveLength(0);
});

test("forget(): the server drops this device, the browser unsubscribes, and notifications aren't marked off", async () => {
  const b = browser({ stub: { signedIn: true }, permission: "granted", subscribed: true });
  await b.R.synced();
  const endpoint = b.sub().endpoint;
  await b.R.forget();
  const un = b.posts.filter((p) => p.url.endsWith("/unsubscribe"));
  expect(un).toHaveLength(1);
  expect(un[0]!.body.endpoint).toBe(endpoint);
  expect(b.sub()).toBeNull();
  expect(b.R.isOff()).toBe(false);
  expect(b.R.signedIn).toBe(false);
  expect(await b.R.pushState()).toBe("off");
});

test("stubScript: defines the queue, keeps setSignedIn, catches the install prompt, loads the client", () => {
  const src = stubScript({ clientUrl: "/api/reach/client.js?v=abc", captureInstallPrompt: true });
  const head = new El("head");
  const listeners: Record<string, (e: any) => void> = {};
  const w: any = { addEventListener: (t: string, f: any) => (listeners[t] = f) };
  new Function("window", "document", src)(w, { head, createElement: (t: string) => new El(t) });
  const r = w.pwaReach;
  expect(r.signedIn).toBeNull();
  r.setSignedIn(1);
  expect(r.signedIn).toBe(true);
  let ran = false;
  r.ready(() => (ran = true));
  expect(ran).toBe(false);
  expect(r.q).toHaveLength(1);
  let prevented = false;
  const e = { preventDefault: () => (prevented = true) };
  listeners.beforeinstallprompt!(e);
  expect(prevented).toBe(true);
  expect(r.bip).toBe(e);
  expect(head.children[0]!.src).toBe("/api/reach/client.js?v=abc");
});
