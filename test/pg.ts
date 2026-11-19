// A disposable Postgres for the store tests. Uses PWA_REACH_TEST_DATABASE_URL, or
// creates pwa_reach_test on the local dev server; null when none is reachable.
import { SQL } from "bun";

export async function testPostgres(): Promise<SQL | null> {
  const url = Bun.env.PWA_REACH_TEST_DATABASE_URL ?? "postgresql://postgres@localhost:5544/pwa_reach_test";
  try {
    const admin = new SQL(url.replace(/\/[^/]+$/, "/postgres"), { max: 1, connectionTimeout: 3 });
    const exists = await admin`select 1 from pg_database where datname = ${new URL(url).pathname.slice(1)}`;
    if (!exists.length) await admin.unsafe(`create database ${new URL(url).pathname.slice(1)}`);
    await admin.end();
    const sql = new SQL(url, { max: 3 });
    await sql.unsafe("drop table if exists reach_delivery, reach_event, reach_subscription, reach_install cascade");
    return sql;
  } catch (e) {
    console.warn(`[test] Postgres not reachable (${e instanceof Error ? e.message : e}); skipping Postgres store tests`);
    return null;
  }
}
