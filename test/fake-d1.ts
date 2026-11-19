// A D1Database stand-in over bun:sqlite: the same SQLite dialect D1 runs.
import { Database } from "bun:sqlite";
import type { D1Like, D1PreparedLike } from "../src/d1.ts";

export function fakeD1(): D1Like {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); // D1 enforces foreign keys
  const stmt = (q: string, binds: unknown[] = []): D1PreparedLike & { exec(): unknown } => ({
    bind: (...v: unknown[]) => stmt(q, v),
    all: async <T,>() => ({ results: db.query(q).all(...(binds as any[])) as T[] }),
    run: async () => ({ meta: { changes: db.query(q).run(...(binds as any[])).changes } }),
    first: async <T,>() => (db.query(q).get(...(binds as any[])) as T) ?? null,
    exec: () => db.query(q).run(...(binds as any[])),
  });
  return {
    prepare: (q) => stmt(q),
    batch: async (ss) => db.transaction(() => ss.map((s) => (s as ReturnType<typeof stmt>).exec()))(),
  };
}
