# pwa-reach

Public npm package `@xenastro/pwa-reach` (MIT): web push + install prompts for
small server-rendered PWAs. Used by daftar, padel_trees, and later the
radaideh family tree (Cloudflare Workers + D1).

- `src/` is runtime-neutral TypeScript: no Buffer, no Node/Bun APIs (Workers must work).
  Only `hono.ts` imports anything (types from the optional `hono` peer).
- `bun test` runs everything. The Postgres contract runs against
  `PWA_REACH_TEST_DATABASE_URL` (default `postgresql://postgres@localhost:5544/pwa_reach_test`,
  trust auth) and is skipped when unreachable. D1 is tested through a bun:sqlite stand-in.
- `web-push` is a devDependency only: the aes128gcm cross-check oracle.
- Client/worker JS lives in `String.raw` templates: no backticks or `${` inside them
  except the injected config.
- Release: bump `version` + CHANGELOG, `npm publish` (prepublishOnly typechecks, tests, builds).
