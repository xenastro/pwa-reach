#!/usr/bin/env node
// npx @xenastro/pwa-reach vapid   → prints a fresh VAPID key pair for your .env
import { generateVapidKeys } from "./webpush.js";

declare const process: { argv: string[]; exit(code: number): never };

const cmd = process.argv[2];
if (cmd === "vapid") {
  const k = await generateVapidKeys();
  console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}\nVAPID_SUBJECT=mailto:you@example.com`);
} else {
  console.log("usage: pwa-reach vapid   (print a new VAPID key pair)");
  process.exit(cmd ? 1 : 0);
}
