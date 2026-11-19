// Postgres store, for Bun's built-in SQL client (`import { SQL } from "bun"`)
// or postgres.js. Both expose the same tagged-template API; only the template
// call and `unsafe` are used. Lists travel as one delimited text
// parameter (cast in SQL), so no driver array or JSON support is needed.

import type { InstallReport, InstallSummary, NewDelivery, NewEvent, ReachStore, SendOutcome, SubscriptionKeys } from "./types.js";
import { audienceNeedle, isDeliveryId, toActivity, toDate, toEventLogs, toSubscription } from "./rows.js";

/** The tagged-template client (Bun SQL / postgres.js). Typed loosely on purpose. */
export type SqlTag = ((strings: TemplateStringsArray, ...values: any[]) => PromiseLike<any>) & {
  unsafe(query: string): PromiseLike<any>;
};

export const postgresSchema = `
create table if not exists reach_subscription (
  id                bigint generated always as identity primary key,
  owner             text not null,
  endpoint          text not null unique,
  p256dh            text not null,
  auth              text not null,
  prefs             text,
  platform          text,
  user_agent        text,
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  last_sent_at      timestamptz,
  last_delivered_at timestamptz,
  last_error        text,
  fail_count        int not null default 0
);
create index if not exists reach_subscription_owner_idx on reach_subscription (owner);

create table if not exists reach_event (
  id          bigint generated always as identity primary key,
  kind        text not null,
  ref         text,
  title       text not null,
  body        text,
  url         text,
  audience    text not null default '[]',
  devices     int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists reach_event_created_idx on reach_event (created_at desc);

create table if not exists reach_delivery (
  id              text primary key,
  event_id        bigint not null references reach_event (id) on delete cascade,
  subscription_id bigint references reach_subscription (id) on delete set null,
  owner           text,
  platform        text,
  sent_at         timestamptz not null default now(),
  push_status     int,
  error           text,
  received_at     timestamptz,
  opened_at       timestamptz
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
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  installed_at  timestamptz
)
`;

const n = (v: unknown) => Number(v);

/** `sql` may be the client itself or a getter (for lazily created clients). */
export function postgresStore(sql: SqlTag | (() => SqlTag)): ReachStore {
  const q = (): SqlTag => (typeof (sql as any).unsafe === "function" ? (sql as SqlTag) : (sql as () => SqlTag)());

  return {
    async migrate() {
      for (const stmt of postgresSchema.split(";").map((s) => s.trim()).filter(Boolean)) await q().unsafe(stmt);
    },

    async upsertSubscription(owner, s, platform, userAgent) {
      const rows = await q()`
        insert into reach_subscription (owner, endpoint, p256dh, auth, platform, user_agent)
        values (${owner}, ${s.endpoint}, ${s.p256dh}, ${s.auth}, ${platform}, ${userAgent})
        on conflict (endpoint) do update set
          owner = excluded.owner, p256dh = excluded.p256dh, auth = excluded.auth,
          platform = excluded.platform, user_agent = excluded.user_agent, last_seen_at = now()
        returning *`;
      return toSubscription(rows[0]);
    },

    async renewSubscription(oldEndpoint, s: SubscriptionKeys) {
      // No transaction (keeps the driver surface to plain queries). If this is
      // interrupted halfway, the page's on-open re-send repairs it.
      const old = await q()`select id from reach_subscription where endpoint = ${oldEndpoint}`;
      if (!old.length) return false;
      if (oldEndpoint !== s.endpoint) await q()`delete from reach_subscription where endpoint = ${s.endpoint}`;
      await q()`
        update reach_subscription set endpoint = ${s.endpoint}, p256dh = ${s.p256dh}, auth = ${s.auth},
          last_seen_at = now(), fail_count = 0, last_error = null
        where id = ${old[0].id}`;
      return true;
    },

    async deleteSubscriptionByEndpoint(endpoint, owner) {
      const rows = await q()`delete from reach_subscription where endpoint = ${endpoint} and owner = ${owner} returning id`;
      return rows.length > 0;
    },

    async deleteSubscription(id, owner) {
      const rows = owner == null
        ? await q()`delete from reach_subscription where id = ${id} returning id`
        : await q()`delete from reach_subscription where id = ${id} and owner = ${owner} returning id`;
      return rows.length > 0;
    },

    async setPrefs(endpoint, owner, prefs) {
      const rows = await q()`
        update reach_subscription set prefs = ${prefs} where endpoint = ${endpoint} and owner = ${owner} returning id`;
      return rows.length > 0;
    },

    async subscriptionsFor(owners) {
      if (!owners.length) return [];
      const rows = await q()`
        select * from reach_subscription
        where owner = any(string_to_array(${owners.join("\n")}::text, chr(10)))
        order by owner, last_seen_at desc`;
      return rows.map(toSubscription);
    },

    async insertEvent(e: NewEvent) {
      const rows = await q()`
        insert into reach_event (kind, ref, title, body, url, audience, devices)
        values (${e.kind}, ${e.ref}, ${e.title}, ${e.body}, ${e.url}, ${JSON.stringify(e.audience)}, ${e.devices})
        returning id`;
      return n(rows[0].id);
    },

    async insertDelivery(x: NewDelivery) {
      await q()`
        insert into reach_delivery (id, event_id, subscription_id, owner, platform)
        values (${x.id}, ${x.eventId}, ${x.subscriptionId}, ${x.owner}, ${x.platform})`;
    },

    async recordSendResult(deliveryId, subscriptionId, r: SendOutcome) {
      await q()`update reach_delivery set push_status = ${r.status}, error = ${r.error ?? null} where id = ${deliveryId}`;
      if (r.gone) {
        await q()`delete from reach_subscription where id = ${subscriptionId}`;
      } else if (r.ok) {
        await q()`update reach_subscription set last_sent_at = now(), fail_count = 0, last_error = null where id = ${subscriptionId}`;
      } else {
        await q()`
          update reach_subscription set last_sent_at = now(), fail_count = fail_count + 1,
            last_error = ${`${r.status}: ${r.error ?? ""}`.slice(0, 300)}
          where id = ${subscriptionId}`;
      }
    },

    async markReceived(deliveryId) {
      if (!isDeliveryId(deliveryId)) return false;
      const rows = await q()`
        update reach_delivery set received_at = now()
        where id = ${deliveryId} and received_at is null
        returning subscription_id`;
      if (!rows.length) return false;
      if (rows[0].subscription_id != null) {
        await q()`update reach_subscription set last_delivered_at = now() where id = ${rows[0].subscription_id}`;
      }
      return true;
    },

    async markOpened(deliveryId) {
      if (!isDeliveryId(deliveryId)) return;
      await q()`
        update reach_delivery set opened_at = coalesce(opened_at, now()), received_at = coalesce(received_at, now())
        where id = ${deliveryId}`;
    },

    async recentEvents(limit, owner) {
      const events = owner == null
        ? await q()`select * from reach_event order by created_at desc, id desc limit ${limit}`
        : await q()`select * from reach_event where audience like ${audienceNeedle(owner)} escape '\\' order by created_at desc, id desc limit ${limit}`;
      if (!events.length) return [];
      const ids = events.map((e: any) => n(e.id)).join(",");
      const dels = owner == null
        ? await q()`select * from reach_delivery where event_id = any(string_to_array(${ids}::text, ',')::bigint[]) order by sent_at`
        : await q()`select * from reach_delivery where owner = ${owner} and event_id = any(string_to_array(${ids}::text, ',')::bigint[]) order by sent_at`;
      return toEventLogs(events, dels);
    },

    async activity(since) {
      const events = await q()`select id, kind, title, devices, created_at from reach_event where kind <> 'test' and created_at >= ${since}`;
      const dels = await q()`
        select d.* from reach_delivery d join reach_event e on e.id = d.event_id
        where e.kind <> 'test' and e.created_at >= ${since}`;
      return toActivity(events, dels);
    },

    async firstEventAt() {
      const rows = await q()`select min(created_at) as t from reach_event where kind <> 'test'`;
      return toDate(rows[0]?.t);
    },

    async reportInstall(r: InstallReport) {
      await q()`
        insert into reach_install (device_id, owner, platform, user_agent, display_mode, in_app, installed_at)
        values (${r.deviceId}, ${r.owner}, ${r.platform}, ${r.userAgent}, ${r.displayMode}, ${r.inApp},
                ${r.installed ? new Date() : null})
        on conflict (device_id) do update set
          owner = coalesce(excluded.owner, reach_install.owner), platform = excluded.platform,
          user_agent = excluded.user_agent, display_mode = excluded.display_mode, in_app = excluded.in_app,
          last_seen_at = now(), installed_at = coalesce(reach_install.installed_at, excluded.installed_at)`;
    },

    async installSummary(): Promise<InstallSummary[]> {
      const rows = await q()`
        select coalesce(platform, 'other') as platform, count(*)::int as devices,
               count(installed_at)::int as installed, count(in_app)::int as in_app
        from reach_install group by 1 order by 2 desc`;
      return rows.map((r: any) => ({ platform: r.platform, devices: n(r.devices), installed: n(r.installed), inApp: n(r.in_app) }));
    },
  };
}

