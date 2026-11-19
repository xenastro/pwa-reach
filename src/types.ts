// Shared types: what a store keeps and what the core hands back.

/** A PushSubscription's essentials (from PushSubscription.toJSON()). */
export interface SubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type Platform = "android" | "ios" | "desktop" | "other";

/** One browser/device that opted in. `owner` is the project's user key, e.g. "user:42". */
export interface Subscription extends SubscriptionKeys {
  id: number;
  owner: string;
  /** Project-defined per-device preference (free text, e.g. "action"); null = default. */
  prefs: string | null;
  platform: Platform | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  lastSentAt: Date | null;
  lastDeliveredAt: Date | null;
  lastError: string | null;
  failCount: number;
}

export interface NewEvent {
  kind: string;
  ref: string | null;
  title: string;
  body: string;
  url: string;
  /** The owners this notification was meant for (empty = "everyone the project chose"). */
  audience: string[];
  devices: number;
}

export interface NewDelivery {
  id: string;
  eventId: number;
  subscriptionId: number;
  owner: string;
  platform: string | null;
}

export interface SendOutcome {
  status: number;
  ok: boolean;
  gone: boolean;
  error?: string;
}

export interface DeliveryLog {
  owner: string | null;
  platform: string | null;
  sentAt: Date;
  pushStatus: number | null;
  error: string | null;
  receivedAt: Date | null;
  openedAt: Date | null;
}

export interface EventLog {
  id: number;
  kind: string;
  ref: string | null;
  title: string;
  body: string | null;
  url: string | null;
  audience: string[];
  devices: number;
  createdAt: Date;
  deliveries: DeliveryLog[];
}

/** Everything the scorecard needs since a date (tests excluded). */
export interface Activity {
  events: { id: number; kind: string; title: string; devices: number; createdAt: Date }[];
  deliveries: (DeliveryLog & { eventId: number })[];
}

export interface InstallReport {
  deviceId: string;
  owner: string | null;
  platform: Platform;
  displayMode: "standalone" | "browser";
  installed: boolean;
  inApp: string | null;
  userAgent: string | null;
}

export interface InstallSummary {
  platform: string;
  devices: number;
  installed: number;
  /** Devices whose latest report came from an in-app browser (Telegram, WhatsApp…). */
  inApp: number;
}

/**
 * Persistence for one project. Two implementations ship: `postgresStore`
 * (Bun SQL / postgres.js) and `d1Store` (Cloudflare D1). Any other database
 * can implement this interface; test/store-contract.ts is the spec.
 */
export interface ReachStore {
  /** Create the tables if missing. Idempotent; safe on every boot. */
  migrate(): Promise<void>;

  upsertSubscription(owner: string, s: SubscriptionKeys, platform: Platform, userAgent: string | null): Promise<Subscription>;
  /** pushsubscriptionchange: move the old row onto new keys. false when the old endpoint is unknown. */
  renewSubscription(oldEndpoint: string, s: SubscriptionKeys): Promise<boolean>;
  deleteSubscriptionByEndpoint(endpoint: string, owner: string): Promise<boolean>;
  /** With `owner`, only that owner's row. */
  deleteSubscription(id: number, owner?: string): Promise<boolean>;
  setPrefs(endpoint: string, owner: string, prefs: string | null): Promise<boolean>;
  subscriptionsFor(owners: string[]): Promise<Subscription[]>;

  insertEvent(e: NewEvent): Promise<number>;
  insertDelivery(d: NewDelivery): Promise<void>;
  /** Store the push service's answer; 404/410 deletes the subscription. */
  recordSendResult(deliveryId: string, subscriptionId: number, r: SendOutcome): Promise<void>;
  /** Service-worker receipt. First one wins; unknown ids are a no-op. */
  markReceived(deliveryId: string): Promise<boolean>;
  /** Tap-through. Also counts as received. */
  markOpened(deliveryId: string): Promise<void>;

  /** Newest first. With `owner`, only events meant for that owner (and only their deliveries). */
  recentEvents(limit: number, owner?: string): Promise<EventLog[]>;
  activity(since: Date): Promise<Activity>;
  /** The first non-test event, or null. */
  firstEventAt(): Promise<Date | null>;

  reportInstall(r: InstallReport): Promise<void>;
  installSummary(): Promise<InstallSummary[]>;
}
