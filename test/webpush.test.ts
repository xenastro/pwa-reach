// Web Push crypto: pinned to RFC 8291 Appendix A, round-tripped through a
// receiver-side decrypt, VAPID verified, and cross-checked against the
// reference Node implementation (web-push, a test-only dependency).

import { test, expect } from "bun:test";
import * as webpush from "web-push";
import { encryptPayload, vapidAuthorization, generateVapidKeys, b64urlDecode, b64urlEncode, sendWebPush } from "../src/webpush.ts";

const strip = (s: string) => s.replace(/\s+/g, "");
// RFC 8291 Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: strip("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"),
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: strip("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV- JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  header: strip(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8`),
  ciphertext: strip(`8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ`),
};

test("base64url round-trips every byte value", () => {
  const all = new Uint8Array(256).map((_, i) => i);
  expect([...b64urlDecode(b64urlEncode(all))]).toEqual([...all]);
  expect(b64urlEncode(new Uint8Array([251, 255]))).toBe("-_8");
});

test("aes128gcm body matches RFC 8291 Appendix A byte-for-byte", async () => {
  const body = await encryptPayload(new TextEncoder().encode(RFC.plaintext), RFC.uaPublic, RFC.auth, {
    asPrivate: b64urlDecode(RFC.asPrivate),
    asPublic: b64urlDecode(RFC.asPublic),
    salt: b64urlDecode(RFC.salt),
  });
  const expected = new Uint8Array([...b64urlDecode(RFC.header), ...b64urlDecode(RFC.ciphertext)]);
  expect(b64urlEncode(body)).toBe(b64urlEncode(expected));
});

/** Receiver side of RFC 8291 (what a browser does). */
async function decrypt(body: Uint8Array, uaPrivD: string, uaPub: string, auth: string): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const record = body.slice(21 + idlen);
  const pub = b64urlDecode(uaPub);
  const priv = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: uaPrivD, x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33)) },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, priv, 256));
  const hk = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: s as BufferSource, info: info as BufferSource },
        await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]),
        n * 8,
      ),
    );
  const te = new TextEncoder();
  const ikm = await hk(b64urlDecode(auth), secret, new Uint8Array([...te.encode("WebPush: info\0"), ...pub, ...asPublic]), 32);
  const cek = await hk(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hk(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, record as BufferSource));
  expect(plain[plain.length - 1]).toBe(2); // last-record delimiter
  return new TextDecoder().decode(plain.slice(0, -1));
}

test("random-key encryption round-trips through a receiver-side decrypt", async () => {
  const payload = JSON.stringify({ web_push: 8030, notification: { title: "يا شجرة، أنت معنا ✅", body: "Wed 9:00 PM" } });
  const body = await encryptPayload(new TextEncoder().encode(payload), RFC.uaPublic, RFC.auth);
  expect(await decrypt(body, RFC.uaPrivate, RFC.uaPublic, RFC.auth)).toBe(payload);
});

async function verifyVapid(header: string, expectSub: string) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  expect(m).not.toBeNull();
  const [hdr, claims, sig] = m![1]!.split(".");
  const c = JSON.parse(new TextDecoder().decode(b64urlDecode(claims!)));
  expect(c.aud).toBe("https://fcm.googleapis.com");
  expect(c.sub).toBe(expectSub);
  expect(JSON.parse(new TextDecoder().decode(b64urlDecode(hdr!))).alg).toBe("ES256");
  const pubKey = await crypto.subtle.importKey("raw", b64urlDecode(m![2]!), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const sigBytes = b64urlDecode(sig!);
  expect(sigBytes.length).toBe(64); // raw r||s, not DER
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pubKey, sigBytes, new TextEncoder().encode(`${hdr}.${claims}`));
}

test("VAPID header: ES256 JWT verifies under k, aud = push-service origin, exp 12h", async () => {
  const keys = { ...(await generateVapidKeys()), subject: "mailto:ops@example.com" };
  const h = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc:def", keys, 1_700_000_000);
  expect(await verifyVapid(h, "mailto:ops@example.com")).toBe(true);
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(h.split(" ")[1]!.slice(2).split(".")[1]!)));
  expect(claims.exp).toBe(1_700_000_000 + 12 * 3600);
});

test("cross-check: web-push's aes128gcm body decrypts with the same receiver, its VAPID verifies the same way", async () => {
  const keys = await generateVapidKeys();
  const payload = { title: "cross-check", n: 42 };
  const req = webpush.generateRequestDetails(
    { endpoint: "https://fcm.googleapis.com/fcm/send/xyz", keys: { p256dh: RFC.uaPublic, auth: RFC.auth } },
    JSON.stringify(payload),
    { vapidDetails: { subject: "mailto:ops@example.com", publicKey: keys.publicKey, privateKey: keys.privateKey }, contentEncoding: "aes128gcm" },
  );
  expect(req.headers["Content-Encoding"]).toBe("aes128gcm");
  expect(JSON.parse(await decrypt(new Uint8Array(req.body as Buffer), RFC.uaPrivate, RFC.uaPublic, RFC.auth))).toEqual(payload);
  expect(await verifyVapid(String(req.headers.Authorization), "mailto:ops@example.com")).toBe(true);

  // Our VAPID header for the same keys has the identical shape and verifies the same way.
  const ours = await vapidAuthorization(req.endpoint, { ...keys, subject: "mailto:ops@example.com" });
  expect(ours.split(", k=")[1]).toBe(String(req.headers.Authorization).split(", k=")[1]!);
  expect(await verifyVapid(ours, "mailto:ops@example.com")).toBe(true);
});

test("sendWebPush: headers, 201 ok, 410 gone, network error never throws", async () => {
  const keys = { ...(await generateVapidKeys()), subject: "mailto:ops@example.com" };
  const target = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: RFC.uaPublic, auth: RFC.auth };
  let seen: RequestInit | undefined;
  const ok = await sendWebPush(target, "{}", keys, {
    fetch: (async (_u: string, init: RequestInit) => ((seen = init), new Response(null, { status: 201 }))) as unknown as typeof fetch,
  });
  expect(ok).toEqual({ status: 201, ok: true, gone: false, error: undefined });
  const h = seen!.headers as Record<string, string>;
  expect(h.TTL).toBe("86400");
  expect(h.Urgency).toBe("high");
  expect(h["Content-Encoding"]).toBe("aes128gcm");
  const gone = await sendWebPush(target, "{}", keys, { fetch: (async () => new Response("expired", { status: 410 })) as unknown as typeof fetch });
  expect(gone).toMatchObject({ status: 410, ok: false, gone: true, error: "expired" });
  const net = await sendWebPush(target, "{}", keys, { fetch: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch });
  expect(net).toMatchObject({ status: 0, ok: false, gone: false, error: "ECONNRESET" });
});
