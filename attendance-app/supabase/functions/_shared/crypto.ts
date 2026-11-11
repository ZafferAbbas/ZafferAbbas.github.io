// Signature checks for keys created in the Android Keystore / iOS Secure Enclave.
//
// Both platforms produce ECDSA P-256 / SHA-256 signatures in DER (ASN.1)
// form, and the app sends public keys as DER SubjectPublicKeyInfo. WebCrypto
// wants signatures as raw r||s (IEEE P1363), so we convert.

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Convert a DER-encoded ECDSA signature to raw r||s (each `size` bytes). */
export function derToP1363(der: Uint8Array, size = 32): Uint8Array<ArrayBuffer> {
  let i = 0;
  const fail = (why: string): never => {
    throw new Error(`bad DER signature: ${why}`);
  };

  if (der[i++] !== 0x30) fail("expected SEQUENCE");
  let seqLen = der[i++];
  if (seqLen === undefined) fail("truncated");
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    if (n < 1 || n > 2) fail("bad length");
    seqLen = 0;
    for (let k = 0; k < n; k++) seqLen = (seqLen << 8) | der[i++];
  }
  if (i + seqLen !== der.length) fail("length mismatch");

  const readInt = (): Uint8Array => {
    if (der[i++] !== 0x02) fail("expected INTEGER");
    const len = der[i++];
    if (!len || i + len > der.length) fail("bad INTEGER length");
    let v = der.subarray(i, i + len);
    i += len;
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) fail("INTEGER too large");
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };

  const r = readInt();
  const s = readInt();
  if (i !== der.length) fail("trailing bytes");

  const out = new Uint8Array(size * 2);
  out.set(r, 0);
  out.set(s, size);
  return out;
}

/** Import a base64 DER SPKI P-256 public key. Throws if it is not one. */
export function importPublicKey(spkiBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    base64ToBytes(spkiBase64),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

/** Verify a base64 DER ECDSA-P256-SHA256 signature over a UTF-8 message. */
export async function verifySignature(
  spkiBase64: string,
  message: string,
  signatureDerBase64: string,
): Promise<boolean> {
  try {
    const key = await importPublicKey(spkiBase64);
    const sig = derToP1363(base64ToBytes(signatureDerBase64));
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      sig,
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

/** 32 random bytes, base64. */
export function randomNonce(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}
