// Web Push sender: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291),
// on WebCrypto only. No dependencies and no runtime-specific APIs (no Buffer),
// so it runs the same on Bun, Node 20+, Deno and Cloudflare Workers.
//
// The encryption is pinned to RFC 8291 Appendix A by test/webpush.test.ts and
// cross-checked against @pushforge/builder. Keys travel as base64url:
// public = the 65-byte uncompressed P-256 point, private = the 32-byte scalar `d`.

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** P-256 private key from raw d + the matching uncompressed public point. */
async function importPrivate(d: Uint8Array, pub: Uint8Array, usage: "ecdsa" | "ecdh"): Promise<CryptoKey> {
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("public key must be a 65-byte uncompressed P-256 point");
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: b64urlEncode(d),
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    ext: true,
  };
  return usage === "ecdsa"
    ? crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
    : crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

/** HKDF-SHA256 (extract + expand) → `len` bytes. */
async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, len: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

export interface EncryptOverrides {
  /** Fixed app-server ECDH key pair + salt. ONLY for the RFC test vector. */
  asPrivate?: Uint8Array;
  asPublic?: Uint8Array;
  salt?: Uint8Array<ArrayBuffer>;
}

/**
 * RFC 8291 aes128gcm body for one push message: header (salt ‖ rs ‖ idlen ‖
 * as_public) followed by a single record (plaintext ‖ 0x02 delimiter, no
 * padding). `p256dh`/`auth` are the subscription's keys, base64url.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  p256dh: string,
  auth: string,
  o: EncryptOverrides = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);
  if (uaPublic.length !== 65) throw new Error("bad p256dh");
  if (authSecret.length !== 16) throw new Error("bad auth secret");

  let asPrivate: CryptoKey;
  let asPublic: Uint8Array;
  if (o.asPrivate && o.asPublic) {
    asPrivate = await importPrivate(o.asPrivate, o.asPublic, "ecdh");
    asPublic = o.asPublic;
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPrivate, 256));

  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = o.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))),
  );
  const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096, big-endian
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, record);
}

export interface VapidKeys {
  publicKey: string; // base64url, 65-byte uncompressed point
  privateKey: string; // base64url, 32-byte d
  subject: string; // "mailto:…" or "https://…"
}

/** VAPID `Authorization` header value for one push-service origin. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  // 12h: the spec caps exp at 24h; some services reject anything near the cap.
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud, exp: nowS + 12 * 3600, sub: keys.subject })));
  const signingInput = `${header}.${claims}`;
  const key = await importPrivate(b64urlDecode(keys.privateKey), b64urlDecode(keys.publicKey), "ecdsa");
  // WebCrypto's ECDSA output is already the raw r||s form JWS wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput));
  return `vapid t=${signingInput}.${b64urlEncode(sig)}, k=${keys.publicKey}`;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendOptions {
  ttlSeconds?: number; // how long the push service keeps an undelivered message
  urgency?: "very-low" | "low" | "normal" | "high";
  timeoutMs?: number;
  /** Replaces global fetch (tests). */
  fetch?: typeof fetch;
}

export interface SendResult {
  /** HTTP status from the push service; 0 = network error / timeout. */
  status: number;
  ok: boolean; // 2xx: the push service accepted (≠ the device received)
  /** 404/410: the subscription is dead and must be deleted. */
  gone: boolean;
  error?: string;
}

/** Encrypt + POST one message to one subscription. Never throws. */
export async function sendWebPush(target: PushTarget, payload: string, keys: VapidKeys, opts: SendOptions = {}): Promise<SendResult> {
  try {
    const body = await encryptPayload(enc.encode(payload), target.p256dh, target.auth);
    const res = await (opts.fetch ?? fetch)(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(target.endpoint, keys),
        TTL: String(opts.ttlSeconds ?? 86400),
        Urgency: opts.urgency ?? "high",
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
      },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    });
    const ok = res.status >= 200 && res.status < 300;
    const text = ok ? "" : (await res.text().catch(() => "")).slice(0, 300);
    return { status: res.status, ok, gone: res.status === 404 || res.status === 410, error: ok ? undefined : text || `HTTP ${res.status}` };
  } catch (e) {
    return { status: 0, ok: false, gone: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A fresh VAPID key pair (base64url). */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { publicKey: b64urlEncode(pub), privateKey: jwk.d! };
}
