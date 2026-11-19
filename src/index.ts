// @xenastro/pwa-reach: web push + install prompts for small server-rendered PWAs.
// Hono routes live in "@xenastro/pwa-reach/hono" (Hono is an optional peer).

export { createReach, buildPayload, tapUrl, platformOf, checkSubject, computeStats, formatStats } from "./core.js";
export type { Reach, ReachConfig, ReachMessage, SendOptions, FanoutResult, ReachStats } from "./core.js";
export { postgresStore, postgresSchema, type SqlTag } from "./postgres.js";
export { d1Store, d1Schema, type D1Like, type D1PreparedLike } from "./d1.js";
export { sendWebPush, encryptPayload, vapidAuthorization, generateVapidKeys, b64urlEncode, b64urlDecode } from "./webpush.js";
export type { VapidKeys, PushTarget, SendResult } from "./webpush.js";
export { DEFAULT_TEXT, type ClientText } from "./client.js";
export { uiCss, deviceCard, devicesTable, scorecard, recentTable, installsTable, fmtWhen, ago, uaShort, esc } from "./ui.js";
export type { PrefsChoice, FormatOptions } from "./ui.js";
export type * from "./types.js";
