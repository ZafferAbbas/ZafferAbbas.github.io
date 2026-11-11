// POST /challenge  { purpose: "register" | "checkin" }
// -> { challenge_id, nonce, expires_at }
//
// Hands out a single-use random value that the phone must sign. It expires
// after 2 minutes, so a captured signed request can't be replayed later.

import { adminClient, handler, HttpError, json, requireUser } from "../_shared/http.ts";
import { randomNonce } from "../_shared/crypto.ts";

const TTL_MS = 2 * 60 * 1000;
const MAX_PER_10_MIN = 30;

Deno.serve(handler(async (req, body) => {
  const user = await requireUser(req);
  const purpose = body.purpose;
  if (purpose !== "register" && purpose !== "checkin") {
    throw new HttpError(400, "bad_request", 'purpose must be "register" or "checkin".');
  }

  const db = adminClient();

  // Simple rate limit.
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count, error: countErr } = await db
    .from("challenges")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gt("created_at", since);
  if (countErr) throw countErr;
  if ((count ?? 0) >= MAX_PER_10_MIN) {
    throw new HttpError(429, "rate_limited", "Too many attempts. Wait a few minutes.");
  }

  // Housekeeping: drop this user's stale challenges.
  await db.from("challenges").delete()
    .eq("user_id", user.id)
    .lt("expires_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());

  const { data, error } = await db
    .from("challenges")
    .insert({
      user_id: user.id,
      purpose,
      nonce: randomNonce(),
      expires_at: new Date(Date.now() + TTL_MS).toISOString(),
    })
    .select("id, nonce, expires_at")
    .single();
  if (error) throw error;

  return json({ challenge_id: data.id, nonce: data.nonce, expires_at: data.expires_at });
}));
