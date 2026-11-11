// Run: deno test supabase/functions/_shared/
import { assert, assertAlmostEquals, assertEquals, assertFalse } from "@std/assert";
import { bytesToBase64, derToP1363, verifySignature } from "./crypto.ts";
import { distanceMeters, localDate } from "./geo.ts";

/** raw r||s -> DER, the way Android/iOS emit signatures. */
function p1363ToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if (v[0] & 0x80) v = new Uint8Array([0, ...v]);
    return new Uint8Array([0x02, v.length, ...v]);
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

async function newKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, spki, raw };
}

async function signDer(key: CryptoKey, msg: string): Promise<string> {
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(msg)),
  );
  return bytesToBase64(p1363ToDer(raw));
}

Deno.test("verifies DER signatures from an SPKI key (Android format)", async () => {
  const { pair, spki } = await newKey();
  // Many signatures so short r/s values (leading zeros) get exercised.
  for (let i = 0; i < 50; i++) {
    const msg = JSON.stringify({ type: "checkin", n: i });
    const sig = await signDer(pair.privateKey, msg);
    assert(await verifySignature(bytesToBase64(spki), msg, sig), `iteration ${i}`);
  }
});

Deno.test("iOS raw key wrapped in the fixed SPKI header is accepted", async () => {
  const { pair, spki, raw } = await newKey();
  const header = new Uint8Array([
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  ]);
  const wrapped = new Uint8Array([...header, ...raw]);
  assertEquals(wrapped, spki); // byte-identical to what WebCrypto exports
  const sig = await signDer(pair.privateKey, "hello");
  assert(await verifySignature(bytesToBase64(wrapped), "hello", sig));
});

Deno.test("rejects tampered payloads, wrong keys and garbage", async () => {
  const a = await newKey();
  const b = await newKey();
  const msg = '{"type":"checkin","latitude":24.86}';
  const sig = await signDer(a.pair.privateKey, msg);
  const spkiA = bytesToBase64(a.spki);

  assertFalse(await verifySignature(spkiA, msg.replace("24.86", "24.87"), sig));
  assertFalse(await verifySignature(bytesToBase64(b.spki), msg, sig));
  assertFalse(await verifySignature(spkiA, msg, "AAAA"));
  assertFalse(await verifySignature("not-a-key", msg, sig));
});

Deno.test("derToP1363 left-pads short integers", () => {
  const der = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x05, 0x02, 0x01, 0x07]);
  const raw = derToP1363(der);
  assertEquals(raw.length, 64);
  assertEquals(raw[31], 5);
  assertEquals(raw[63], 7);
});

Deno.test("distanceMeters", () => {
  assertEquals(distanceMeters(10, 20, 10, 20), 0);
  // ~111.2 km per degree of latitude.
  assertAlmostEquals(distanceMeters(0, 0, 1, 0), 111_195, 50);
  // ~100 m north.
  assertAlmostEquals(distanceMeters(24.8607, 67.0011, 24.8616, 67.0011), 100, 1);
});

Deno.test("localDate respects time zone", () => {
  const at = new Date("2026-11-11T20:30:00Z");
  assertEquals(localDate("UTC", at), "2026-11-11");
  assertEquals(localDate("Asia/Karachi", at), "2026-11-12"); // UTC+5
});
