// createReach(): the project-facing object. Runtime-neutral: no Bun, Node or
// Workers APIs. On Cloudflare Workers, wrap `send()` in ctx.waitUntil() when
// you don't await it.

import { sendWebPush, type VapidKeys } from "./webpush.js";
import type { Platform, ReachStore, Subscription, EventLog, InstallSummary } from "./types.js";
import { clientScript, headSnippet, stubScript, DEFAULT_TEXT, type ClientText } from "./client.js";
import { serviceWorkerScript, pushWorkerScript } from "./sw.js";

export interface ReachConfig {
  store: ReachStore;
  /** From env. Missing keys = push off (send() is a no-op, `configured` is false). */
  vapid?: { publicKey?: string | null; privateKey?: string | null; subject?: string | null } | null;
  /** Absolute origin of the app, e.g. "https://padeltrees.radrek.com". Tap links must be absolute for iOS. */
  appUrl: string;
  /** Shown in default texts and as the fallback notification title. */
  appName: string;
  /** Notification icon (colour). Default "/icons/icon-192.png". */
  icon?: string;
  /** Android status-bar icon: white glyph on transparent, ~96px. Without it Android shows a bell. */
  badge?: string | null;
  /** Where the package's routes live. Default "/reach". */
  basePath?: string;
  /** Service worker URL, served at the root so its scope covers the app. Default "/sw.js". */
  swPath?: string;
  /** Default 24h. */
  ttlSeconds?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  /** Notification text direction/language. Default "auto" / "en". */
  dir?: "auto" | "ltr" | "rtl";
  lang?: string;
  /** Page a test notification opens. Default "/". */
  settingsPath?: string;
  /** Time zone for the test notification's clock. */
  timeZone?: string;
  /** Override any of the banner/help texts (English by default). `{app}` = appName. */
  text?: Partial<ClientText>;
  /** Each device reports once a day whether it runs installed (reach_install). Default true. */
  installReport?: boolean;
  /** Hold Android's install prompt for our own button instead of Chrome's mini-infobar. Default true. */
  captureInstallPrompt?: boolean;
  /** Replaces global fetch for sends (tests). */
  fetch?: typeof fetch;
}

export interface ReachMessage {
  /** Free text; "test" is excluded from stats. Default "info". */
  kind?: string;
  title: string;
  body?: string;
  /** Path (or absolute URL on this app) opened on tap. */
  path: string;
  /** Same tag = replaces the previous notification on the device. */
  tag?: string;
  /** Project reference kept with the event, e.g. "event:12". */
  ref?: string;
  dir?: "auto" | "ltr" | "rtl";
  lang?: string;
}

export interface SendOptions {
  /** Drop devices, e.g. by their prefs. */
  filter?: (s: Subscription) => boolean;
}

export interface FanoutResult {
  eventId: number | null;
  devices: number;
  accepted: number;
  results: { subscriptionId: number; owner: string; platform: string | null; status: number; error?: string; gone: boolean }[];
}

export interface ReachStats {
  since: Date;
  events: number;
  eventsNoDevice: number;
  eventsReached: number;
  deliveries: number;
  accepted: number;
  failed: number;
  received: number;
  opened: number;
  byPlatform: { platform: string; deliveries: number; accepted: number; received: number; opened: number }[];
  /** Seconds from send to the device's receipt. */
  latency: { p50: number; p90: number; max: number } | null;
  /** Deliveries with no receipt, newest first (max 50). */
  unconfirmed: { at: Date; title: string; platform: string | null; status: number | null; error: string | null }[];
}

export interface Reach {
  readonly config: Readonly<Required<Pick<ReachConfig, "appName" | "appUrl" | "basePath" | "swPath">>>;
  readonly store: ReachStore;
  /** VAPID keys are set. */
  readonly configured: boolean;
  readonly publicKey: string | null;
  /** Record the event, then push to every device of `to` (owners). Never throws. */
  send(m: ReachMessage, to: string[], opts?: SendOptions): Promise<FanoutResult>;
  /** A test to one device (by endpoint) or to all of `owner`'s devices. */
  sendTest(owner: string, endpoint?: string): Promise<FanoutResult>;
  devices(owner: string): Promise<Subscription[]>;
  recentEvents(limit?: number, owner?: string): Promise<EventLog[]>;
  stats(since?: Date): Promise<ReachStats>;
  installs(): Promise<InstallSummary[]>;
  /** Service worker source (served at swPath). */
  serviceWorker(): string;
  /** Just the push handlers, for importScripts() into a worker you already have. */
  pushWorker(): string;
  /** Page script source (served at {basePath}/client.js). */
  clientScript(): string;
  /** Put in every page's <head>: a tiny inline stub + the deferred client script. */
  headTags(opts?: { signedIn?: boolean }): string;
  /** The stub as a file (served at {basePath}/stub.js), for a strict CSP or a single-page app. */
  stubScript(): string;
}

export function platformOf(ua: string | null | undefined): Platform {
  const s = ua ?? "";
  if (/Android/i.test(s)) return "android";
  if (/iPhone|iPad|iPod/i.test(s)) return "ios";
  if (/Macintosh|Windows|Linux|CrOS/i.test(s)) return "desktop";
  return "other";
}

function newDeliveryId(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Short stable hash, for cache-busting script URLs. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** The tap-through URL; `via=push&d=…` lets the server stamp opened_at. */
export function tapUrl(appUrl: string, path: string, deliveryId: string): string {
  const u = new URL(path, appUrl.replace(/\/+$/, "") + "/");
  u.searchParams.set("via", "push");
  u.searchParams.set("d", deliveryId);
  return u.href;
}

/**
 * The encrypted plaintext: Declarative Web Push shape (`web_push: 8030`, Safari
 * 18.4+) that every other browser hands to our worker as JSON. With `mutable`,
 * Safari still runs the worker (so it can ack) and shows the declarative
 * notification itself if the worker fails.
 */
export function buildPayload(
  m: ReachMessage,
  deliveryId: string,
  o: { appUrl: string; lang?: string; dir?: string; nowMs?: number },
): string {
  return JSON.stringify({
    web_push: 8030,
    notification: {
      title: m.title,
      body: m.body ?? "",
      navigate: tapUrl(o.appUrl, m.path, deliveryId),
      tag: m.tag,
      lang: m.lang ?? o.lang ?? "en",
      dir: m.dir ?? o.dir ?? "auto",
      silent: false,
      timestamp: o.nowMs ?? Date.now(),
    },
    mutable: true,
    reach: { d: deliveryId, kind: m.kind ?? "info" },
  });
}

/** Apple rejects VAPID subjects that aren't mailto: or a public https URL. */
export function checkSubject(subject: string): string | null {
  if (/^mailto:[^@\s]+@[^@\s]+$/.test(subject)) return null;
  try {
    const u = new URL(subject);
    if (u.protocol !== "https:") return "VAPID subject must be mailto: or https:";
    if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname) || u.hostname.endsWith(".local")) {
      return "VAPID subject points at localhost; Apple's push service rejects it";
    }
    return null;
  } catch {
    return "VAPID subject is not a URL or mailto:";
  }
}

const pctile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;

export function computeStats(a: import("./types.js").Activity, since: Date): ReachStats {
  const ok = (s: number | null) => s != null && s >= 200 && s < 300;
  const reached = new Set(a.deliveries.filter((x) => x.receivedAt).map((x) => x.eventId));
  const plat = new Map<string, ReachStats["byPlatform"][number]>();
  for (const x of a.deliveries) {
    const k = x.platform ?? "other";
    if (!plat.has(k)) plat.set(k, { platform: k, deliveries: 0, accepted: 0, received: 0, opened: 0 });
    const p = plat.get(k)!;
    p.deliveries++;
    if (ok(x.pushStatus)) p.accepted++;
    if (x.receivedAt) p.received++;
    if (x.openedAt) p.opened++;
  }
  const lat = a.deliveries
    .filter((x) => x.receivedAt)
    .map((x) => Math.max(0, (x.receivedAt!.getTime() - x.sentAt.getTime()) / 1000))
    .sort((x, y) => x - y);
  const titles = new Map(a.events.map((e) => [e.id, e]));
  return {
    since,
    events: a.events.length,
    eventsNoDevice: a.events.filter((e) => e.devices === 0).length,
    eventsReached: a.events.filter((e) => reached.has(e.id)).length,
    deliveries: a.deliveries.length,
    accepted: a.deliveries.filter((x) => ok(x.pushStatus)).length,
    failed: a.deliveries.filter((x) => x.pushStatus != null && !ok(x.pushStatus)).length,
    received: a.deliveries.filter((x) => x.receivedAt).length,
    opened: a.deliveries.filter((x) => x.openedAt).length,
    byPlatform: [...plat.values()].sort((x, y) => y.deliveries - x.deliveries),
    latency: lat.length ? { p50: pctile(lat, 0.5), p90: pctile(lat, 0.9), max: lat[lat.length - 1]! } : null,
    unconfirmed: a.deliveries
      .filter((x) => !x.receivedAt)
      .sort((x, y) => y.sentAt.getTime() - x.sentAt.getTime())
      .slice(0, 50)
      .map((x) => ({
        at: titles.get(x.eventId)?.createdAt ?? x.sentAt,
        title: titles.get(x.eventId)?.title ?? "",
        platform: x.platform,
        status: x.pushStatus,
        error: x.error,
      })),
  };
}

/** Plain-text scorecard, for a `scripts/push-stats.ts` in each project. */
export function formatStats(s: ReachStats): string {
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
  const L: string[] = [];
  L.push(`Web push since ${s.since.toISOString()} (test pushes excluded)`, "");
  L.push(`notifications decided      ${s.events}`);
  L.push(`  …with no device enrolled ${s.eventsNoDevice}`);
  L.push(`  …reached ≥1 device       ${s.eventsReached}  (${pct(s.eventsReached, s.events)})`);
  L.push(`device sends               ${s.deliveries}`);
  L.push(`  accepted by push service ${s.accepted}  (${pct(s.accepted, s.deliveries)})`);
  L.push(`  push-service failures    ${s.failed}`);
  L.push(`  received (SW ack or tap) ${s.received}  (${pct(s.received, s.accepted)} of accepted)`);
  L.push(`  opened                   ${s.opened}  (${pct(s.opened, s.received)} of received)`);
  if (s.byPlatform.length) {
    L.push("", "by platform:");
    for (const p of s.byPlatform) {
      L.push(`  ${p.platform.padEnd(8)} sent ${p.deliveries}  accepted ${p.accepted}  received ${p.received} (${pct(p.received, p.accepted)})  opened ${p.opened}`);
    }
  }
  if (s.latency) L.push("", `receipt latency: p50 ${s.latency.p50.toFixed(1)}s · p90 ${s.latency.p90.toFixed(1)}s · max ${s.latency.max.toFixed(0)}s`);
  if (s.unconfirmed.length) {
    L.push("", `unconfirmed deliveries (${s.unconfirmed.length}${s.unconfirmed.length === 50 ? "+" : ""}):`);
    for (const m of s.unconfirmed) {
      L.push(`  ${m.at.toISOString().slice(0, 16)}  ${String(m.platform).padEnd(8)} ${m.status ?? "—"}  ${m.title}${m.error ? `  [${m.error.slice(0, 60)}]` : ""}`);
    }
  }
  return L.join("\n");
}

export function createReach(cfg: ReachConfig): Reach {
  const appUrl = cfg.appUrl.replace(/\/+$/, "");
  const basePath = (cfg.basePath ?? "/reach").replace(/\/+$/, "");
  const swPath = cfg.swPath ?? "/sw.js";
  const pub = cfg.vapid?.publicKey?.trim() || null;
  const priv = cfg.vapid?.privateKey?.trim() || null;
  const subject = cfg.vapid?.subject?.trim() || appUrl;
  const keys: VapidKeys | null = pub && priv ? { publicKey: pub, privateKey: priv, subject } : null;
  if (keys) {
    const problem = checkSubject(subject);
    if (problem) console.warn(`[pwa-reach] ${problem} (${subject}). Set vapid.subject to mailto:you@… or your https URL.`);
  }
  const text: ClientText = { ...DEFAULT_TEXT, ...cfg.text };
  const ttl = cfg.ttlSeconds ?? 86400;
  const urgency = cfg.urgency ?? "high";

  const workerOpts = { appName: cfg.appName, publicKey: pub ?? "", basePath, icon: cfg.icon ?? "/icons/icon-192.png", badge: cfg.badge ?? null };
  const swSource = serviceWorkerScript(workerOpts);
  const pushSource = pushWorkerScript(workerOpts);
  const clientSource = clientScript({
    appName: cfg.appName,
    publicKey: pub ?? "",
    basePath,
    swPath,
    text,
    installReport: cfg.installReport ?? true,
  });
  const clientUrl = `${basePath}/client.js?v=${hash(clientSource)}`;
  const stubSource = stubScript({ clientUrl, captureInstallPrompt: cfg.captureInstallPrompt ?? true });

  async function fanout(m: ReachMessage, targets: Subscription[], audience: string[]): Promise<FanoutResult> {
    const out: FanoutResult = { eventId: null, devices: targets.length, accepted: 0, results: [] };
    if (!keys) return out;
    try {
      out.eventId = await cfg.store.insertEvent({
        kind: m.kind ?? "info",
        ref: m.ref ?? null,
        title: m.title,
        body: m.body ?? "",
        url: m.path,
        audience,
        devices: targets.length,
      });
    } catch (e) {
      console.error("[pwa-reach] event insert failed:", e instanceof Error ? e.message : e);
      return out;
    }
    await Promise.all(
      targets.map(async (s) => {
        const id = newDeliveryId();
        try {
          await cfg.store.insertDelivery({ id, eventId: out.eventId!, subscriptionId: s.id, owner: s.owner, platform: s.platform });
        } catch (e) {
          console.error("[pwa-reach] delivery insert failed:", e instanceof Error ? e.message : e);
          return;
        }
        const payload = buildPayload(m, id, { appUrl, lang: cfg.lang, dir: cfg.dir });
        const r = await sendWebPush(s, payload, keys, { ttlSeconds: ttl, urgency, fetch: cfg.fetch });
        if (r.ok) out.accepted++;
        else console.warn(`[pwa-reach] subscription ${s.id} (${s.platform}) → ${r.status} ${r.error ?? ""}`);
        out.results.push({ subscriptionId: s.id, owner: s.owner, platform: s.platform, status: r.status, error: r.error, gone: r.gone });
        await cfg.store.recordSendResult(id, s.id, r).catch((e) => console.error("[pwa-reach] record failed:", e));
      }),
    );
    return out;
  }

  return {
    config: { appName: cfg.appName, appUrl, basePath, swPath },
    store: cfg.store,
    configured: !!keys,
    publicKey: pub,

    async send(m, to, opts = {}) {
      if (!keys) return { eventId: null, devices: 0, accepted: 0, results: [] };
      try {
        const owners = [...new Set(to)];
        let subs = await cfg.store.subscriptionsFor(owners);
        if (opts.filter) subs = subs.filter(opts.filter);
        return await fanout(m, subs, owners);
      } catch (e) {
        console.error("[pwa-reach] send failed:", e instanceof Error ? e.message : e);
        return { eventId: null, devices: 0, accepted: 0, results: [] };
      }
    },

    async sendTest(owner, endpoint) {
      let subs = await cfg.store.subscriptionsFor([owner]);
      if (endpoint) subs = subs.filter((s) => s.endpoint === endpoint);
      const at = new Date().toLocaleTimeString("en-GB", { timeZone: cfg.timeZone, hour: "2-digit", minute: "2-digit" });
      return fanout(
        {
          kind: "test",
          title: text.testTitle.replace(/\{app\}/g, cfg.appName),
          body: text.testBody.replace(/\{time\}/g, at),
          path: cfg.settingsPath ?? "/",
          tag: `test-${Date.now()}`,
          dir: "auto",
        },
        subs,
        [owner],
      );
    },

    devices: (owner) => cfg.store.subscriptionsFor([owner]),
    recentEvents: (limit = 40, owner) => cfg.store.recentEvents(limit, owner),
    async stats(since) {
      const from = since ?? (await cfg.store.firstEventAt()) ?? new Date();
      return computeStats(await cfg.store.activity(from), from);
    },
    installs: () => cfg.store.installSummary(),
    serviceWorker: () => swSource,
    pushWorker: () => pushSource,
    clientScript: () => clientSource,
    stubScript: () => stubSource,
    headTags: (o = {}) =>
      headSnippet({ clientUrl, signedIn: o.signedIn, captureInstallPrompt: cfg.captureInstallPrompt ?? true }),
  };
}
