// Cloudflare D1 store (SQLite). Typed structurally so this package doesn't
// need @cloudflare/workers-types: pass `env.DB` (a D1Database). Timestamps are
// ISO-8601 text written by JS, so they compare correctly as strings.
//
// Create the tables either with `await store.migrate()` or by copying
// `d1Schema` into a wrangler migration file.

import type { InstallReport, InstallSummary, NewDelivery, NewEvent, ReachStore, SendOutcome, SubscriptionKeys } from "./types.js";
import { audienceNeedle, isDeliveryId, toActivity, toDate, toEventLogs, toSubscription } from "./rows.js";

export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike;
  all<T = Record<string, any>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
  first<T = Record<string, any>>(): Promise<T | null>;
}
export interface D1Like {
  prepare(query: string): D1PreparedLike;
  batch(statements: D1PreparedLike[]): Promise<unknown[]>;
}

export const d1Schema = `
create table if not exists reach_subscription (
  id                integer primary key autoincrement,
  owner             text not null,
  endpoint          text not null unique,
  p256dh            text not null,
  auth              text not null,
  prefs             text,
  platform          text,
  user_agent        text,
  created_at        text not null,
  last_seen_at      text not null,
  last_sent_at      text,
  last_delivered_at text,
  last_error        text,
  fail_count        integer not null default 0
);
create index if not exists reach_subscription_owner_idx on reach_subscription (owner);

create table if not exists reach_event (
  id          integer primary key autoincrement,
  kind        text not null,
  ref         text,
  title       text not null,
  body        text,
  url         text,
  audience    text not null default '[]',
  devices     integer not null default 0,
  created_at  text not null
);
create index if not exists reach_event_created_idx on reach_event (created_at);

create table if not exists reach_delivery (
  id              text primary key,
  event_id        integer not null references reach_event (id) on delete cascade,
  subscription_id integer references reach_subscription (id) on delete set null,
  owner           text,
  platform        text,
  sent_at         text not null,
  push_status     integer,
  error           text,
  received_at     text,
  opened_at       text
);
create index if not exists reach_delivery_event_idx on reach_delivery (event_id);
create index if not exists reach_delivery_sub_idx on reach_delivery (subscription_id);

create table if not exists reach_install (
  device_id     text primary key,
  owner         text,
  platform      text,
  user_agent    text,
  display_mode  text,
  in_app        text,
  first_seen_at text not null,
  last_seen_at  text not null,
  installed_at  text
)
`;

const now = () => new Date().toISOString();
const n = (v: unknown) => Number(v);

export function d1Store(db: D1Like): ReachStore {
  const all = async (sql: string, ...v: unknown[]) => (await db.prepare(sql).bind(...v).all()).results;
  const first = (sql: string, ...v: unknown[]) => db.prepare(sql).bind(...v).first();
  const run = (sql: string, ...v: unknown[]) => db.prepare(sql).bind(...v).run();
  const changed = (r: { meta?: { changes?: number } }) => (r.meta?.changes ?? 0) > 0;

  return {
    async migrate() {
      const stmts = d1Schema.split(";").map((s) => s.trim()).filter(Boolean);
      await db.batch(stmts.map((s) => db.prepare(s)));
    },

    async upsertSubscription(owner, s, platform, userAgent) {
      const t = now();
      const row = await first(
        `insert into reach_subscription (owner, endpoint, p256dh, auth, platform, user_agent, created_at, last_seen_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (endpoint) do update set
           owner = excluded.owner, p256dh = excluded.p256dh, auth = excluded.auth,
           platform = excluded.platform, user_agent = excluded.user_agent, last_seen_at = excluded.last_seen_at
         returning *`,
        owner, s.endpoint, s.p256dh, s.auth, platform, userAgent, t, t,
      );
      return toSubscription(row!);
    },

    async renewSubscription(oldEndpoint, s: SubscriptionKeys) {
      const old = await first(`select id from reach_subscription where endpoint = ?`, oldEndpoint);
      if (!old) return false;
      const stmts: D1PreparedLike[] = [];
      if (oldEndpoint !== s.endpoint) stmts.push(db.prepare(`delete from reach_subscription where endpoint = ?`).bind(s.endpoint));
      stmts.push(
        db.prepare(
          `update reach_subscription set endpoint = ?, p256dh = ?, auth = ?, last_seen_at = ?, fail_count = 0, last_error = null where id = ?`,
        ).bind(s.endpoint, s.p256dh, s.auth, now(), old.id),
      );
      await db.batch(stmts); // atomic
      return true;
    },

    async deleteSubscriptionByEndpoint(endpoint, owner) {
      return changed(await run(`delete from reach_subscription where endpoint = ? and owner = ?`, endpoint, owner));
    },

    async deleteSubscription(id, owner) {
      return changed(
        owner == null
          ? await run(`delete from reach_subscription where id = ?`, id)
          : await run(`delete from reach_subscription where id = ? and owner = ?`, id, owner),
      );
    },

    async setPrefs(endpoint, owner, prefs) {
      return changed(await run(`update reach_subscription set prefs = ? where endpoint = ? and owner = ?`, prefs, endpoint, owner));
    },

    async subscriptionsFor(owners) {
      if (!owners.length) return [];
      const rows = await all(
        `select * from reach_subscription where owner in (select value from json_each(?)) order by owner, last_seen_at desc`,
        JSON.stringify(owners),
      );
      return rows.map(toSubscription);
    },

    async insertEvent(e: NewEvent) {
      const row = await first(
        `insert into reach_event (kind, ref, title, body, url, audience, devices, created_at) values (?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        e.kind, e.ref, e.title, e.body, e.url, JSON.stringify(e.audience), e.devices, now(),
      );
      return n(row!.id);
    },

    async insertDelivery(x: NewDelivery) {
      await run(
        `insert into reach_delivery (id, event_id, subscription_id, owner, platform, sent_at) values (?, ?, ?, ?, ?, ?)`,
        x.id, x.eventId, x.subscriptionId, x.owner, x.platform, now(),
      );
    },

    async recordSendResult(deliveryId, subscriptionId, r: SendOutcome) {
      const t = now();
      const stmts = [db.prepare(`update reach_delivery set push_status = ?, error = ? where id = ?`).bind(r.status, r.error ?? null, deliveryId)];
      if (r.gone) stmts.push(db.prepare(`delete from reach_subscription where id = ?`).bind(subscriptionId));
      else if (r.ok) stmts.push(db.prepare(`update reach_subscription set last_sent_at = ?, fail_count = 0, last_error = null where id = ?`).bind(t, subscriptionId));
      else
        stmts.push(
          db.prepare(`update reach_subscription set last_sent_at = ?, fail_count = fail_count + 1, last_error = ? where id = ?`)
            .bind(t, `${r.status}: ${r.error ?? ""}`.slice(0, 300), subscriptionId),
        );
      await db.batch(stmts);
    },

    async markReceived(deliveryId) {
      if (!isDeliveryId(deliveryId)) return false;
      const t = now();
      const row = await first(
        `update reach_delivery set received_at = ? where id = ? and received_at is null returning subscription_id`,
        t, deliveryId,
      );
      if (!row) return false;
      if (row.subscription_id != null) await run(`update reach_subscription set last_delivered_at = ? where id = ?`, t, row.subscription_id);
      return true;
    },

    async markOpened(deliveryId) {
      if (!isDeliveryId(deliveryId)) return;
      const t = now();
      await run(
        `update reach_delivery set opened_at = coalesce(opened_at, ?), received_at = coalesce(received_at, ?) where id = ?`,
        t, t, deliveryId,
      );
    },

    async recentEvents(limit, owner) {
      const events = owner == null
        ? await all(`select * from reach_event order by created_at desc, id desc limit ?`, limit)
        : await all(`select * from reach_event where audience like ? escape '\\' order by created_at desc, id desc limit ?`, audienceNeedle(owner), limit);
      if (!events.length) return [];
      const ids = JSON.stringify(events.map((e) => n(e.id)));
      const dels = owner == null
        ? await all(`select * from reach_delivery where event_id in (select value from json_each(?)) order by sent_at`, ids)
        : await all(`select * from reach_delivery where owner = ? and event_id in (select value from json_each(?)) order by sent_at`, owner, ids);
      return toEventLogs(events, dels);
    },

    async activity(since) {
      const s = since.toISOString();
      const events = await all(`select id, kind, title, devices, created_at from reach_event where kind <> 'test' and created_at >= ?`, s);
      const dels = await all(
        `select d.* from reach_delivery d join reach_event e on e.id = d.event_id where e.kind <> 'test' and e.created_at >= ?`,
        s,
      );
      return toActivity(events, dels);
    },

    async firstEventAt() {
      const row = await first(`select min(created_at) as t from reach_event where kind <> 'test'`);
      return toDate(row?.t);
    },

    async reportInstall(r: InstallReport) {
      const t = now();
      await run(
        `insert into reach_install (device_id, owner, platform, user_agent, display_mode, in_app, first_seen_at, last_seen_at, installed_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (device_id) do update set
           owner = coalesce(excluded.owner, reach_install.owner), platform = excluded.platform,
           user_agent = excluded.user_agent, display_mode = excluded.display_mode, in_app = excluded.in_app,
           last_seen_at = excluded.last_seen_at, installed_at = coalesce(reach_install.installed_at, excluded.installed_at)`,
        r.deviceId, r.owner, r.platform, r.userAgent, r.displayMode, r.inApp, t, t, r.installed ? t : null,
      );
    },

    async installSummary(): Promise<InstallSummary[]> {
      const rows = await all(
        `select coalesce(platform, 'other') as platform, count(*) as devices, count(installed_at) as installed, count(in_app) as in_app
         from reach_install group by 1 order by 2 desc`,
      );
      return rows.map((r) => ({ platform: r.platform, devices: n(r.devices), installed: n(r.installed), inApp: n(r.in_app) }));
    },
  };
}
