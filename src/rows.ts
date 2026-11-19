// Row → object mapping shared by the Postgres and D1 stores.

import type { Activity, EventLog, Platform, Subscription } from "./types.js";

const n = (v: unknown) => Number(v);
export const toDate = (v: unknown): Date | null => (v == null ? null : v instanceof Date ? v : new Date(String(v)));

export function toSubscription(r: Record<string, any>): Subscription {
  return {
    id: n(r.id),
    owner: r.owner,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    prefs: r.prefs ?? null,
    platform: (r.platform ?? null) as Platform | null,
    userAgent: r.user_agent ?? null,
    createdAt: toDate(r.created_at)!,
    lastSeenAt: toDate(r.last_seen_at)!,
    lastSentAt: toDate(r.last_sent_at),
    lastDeliveredAt: toDate(r.last_delivered_at),
    lastError: r.last_error ?? null,
    failCount: n(r.fail_count ?? 0),
  };
}

function parseAudience(s: unknown): string[] {
  try {
    const v = JSON.parse(String(s ?? "[]"));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** LIKE pattern matching an owner as a JSON string inside the audience text (escape char: backslash). */
export function audienceNeedle(owner: string): string {
  return `%${JSON.stringify(owner).replace(/[\\%_]/g, (c) => "\\" + c)}%`;
}

function toDeliveryLog(x: Record<string, any>) {
  return {
    owner: x.owner ?? null,
    platform: x.platform ?? null,
    sentAt: toDate(x.sent_at)!,
    pushStatus: x.push_status == null ? null : n(x.push_status),
    error: x.error ?? null,
    receivedAt: toDate(x.received_at),
    openedAt: toDate(x.opened_at),
  };
}

export function toEventLogs(events: Record<string, any>[], deliveries: Record<string, any>[]): EventLog[] {
  const by = new Map<number, EventLog["deliveries"]>();
  for (const x of deliveries) {
    const k = n(x.event_id);
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(toDeliveryLog(x));
  }
  return events.map((e) => ({
    id: n(e.id),
    kind: e.kind,
    ref: e.ref ?? null,
    title: e.title,
    body: e.body ?? null,
    url: e.url ?? null,
    audience: parseAudience(e.audience),
    devices: n(e.devices),
    createdAt: toDate(e.created_at)!,
    deliveries: by.get(n(e.id)) ?? [],
  }));
}

export function toActivity(events: Record<string, any>[], deliveries: Record<string, any>[]): Activity {
  return {
    events: events.map((e) => ({ id: n(e.id), kind: e.kind, title: e.title, devices: n(e.devices), createdAt: toDate(e.created_at)! })),
    deliveries: deliveries.map((x) => ({ eventId: n(x.event_id), ...toDeliveryLog(x) })),
  };
}

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const isDeliveryId = (s: string) => TOKEN_RE.test(s);
