// POST /register-device  { payload: string, signature: string }
//
// payload is the exact JSON string the phone signed:
//   { "type": "register", "challenge_id", "nonce", "platform", "public_key" }
//
// The signature is made with the NEW key, proving the phone really holds the
// private key (and that the user passed a biometric check to use it).
//
// First phone for a user -> "active". Any later phone -> "pending" until an
// admin approves it with the approve_device() SQL function.

import { adminClient, consumeChallenge, handler, HttpError, json, requireUser, str } from "../_shared/http.ts";
import { importPublicKey, verifySignature } from "../_shared/crypto.ts";

Deno.serve(handler(async (req, body) => {
  const user = await requireUser(req);
  const payloadText = str(body.payload, "payload");
  const signature = str(body.signature, "signature");

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw new HttpError(400, "bad_request", "payload must be JSON.");
  }
  if (payload.type !== "register") {
    throw new HttpError(400, "bad_request", "Wrong payload type.");
  }
  const challengeId = str(payload.challenge_id, "challenge_id");
  const nonce = str(payload.nonce, "nonce");
  const publicKey = str(payload.public_key, "public_key");
  const platform = payload.platform;
  if (platform !== "android" && platform !== "ios") {
    throw new HttpError(400, "bad_request", "Unknown platform.");
  }

  try {
    await importPublicKey(publicKey);
  } catch {
    throw new HttpError(400, "bad_key", "Public key must be an EC P-256 key.");
  }

  const db = adminClient();
  const expectedNonce = await consumeChallenge(db, user.id, challengeId, "register");
  if (nonce !== expectedNonce) {
    throw new HttpError(400, "challenge_invalid", "This request expired. Please try again.");
  }
  if (!(await verifySignature(publicKey, payloadText, signature))) {
    throw new HttpError(400, "bad_signature", "Could not verify this phone.");
  }

  const { data: existing, error: exErr } = await db
    .from("devices")
    .select("id, status, public_key")
    .eq("user_id", user.id);
  if (exErr) throw exErr;

  const same = existing?.find((d) => d.public_key === publicKey);
  if (same) return json({ device_id: same.id, status: same.status });

  // First ever device is trusted automatically; later ones need an admin.
  const status = (existing?.length ?? 0) === 0 ? "active" : "pending";

  if (status === "pending") {
    // Only one pending request at a time: replace any older one.
    await db.from("devices").update({ status: "revoked" })
      .eq("user_id", user.id).eq("status", "pending");
  }

  const { data, error } = await db
    .from("devices")
    .insert({
      user_id: user.id,
      public_key: publicKey,
      platform,
      status,
      approved_at: status === "active" ? new Date().toISOString() : null,
    })
    .select("id, status")
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new HttpError(409, "conflict", "This phone is already registered.");
    }
    throw error;
  }

  return json({ device_id: data.id, status: data.status });
}));
