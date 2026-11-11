// POST /check-in  { payload: string, signature: string }
//
// payload is the exact JSON string the phone signed after a biometric check:
//   { "type": "checkin", "challenge_id", "nonce", "site_id",
//     "latitude", "longitude", "accuracy_m", "is_mocked" }
//
// Every rule is enforced HERE, not in the app: the app's own checks can be
// bypassed on a tampered phone, but it cannot forge the signature.

import { adminClient, consumeChallenge, handler, HttpError, json, num, requireUser, str } from "../_shared/http.ts";
import { verifySignature } from "../_shared/crypto.ts";
import { distanceMeters, localDate } from "../_shared/geo.ts";

// Readings less precise than this are rejected (GPS indoors can be poor; tune it).
const MAX_ACCURACY_M = Number(Deno.env.get("MAX_ACCURACY_M") ?? "50");
// "Day" boundaries for the once-per-day rule.
const TIME_ZONE = Deno.env.get("ATTENDANCE_TIME_ZONE") ?? "UTC";

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
  if (payload.type !== "checkin") {
    throw new HttpError(400, "bad_request", "Wrong payload type.");
  }
  const challengeId = str(payload.challenge_id, "challenge_id");
  const nonce = str(payload.nonce, "nonce");
  const siteId = str(payload.site_id, "site_id");
  const lat = num(payload.latitude, "latitude");
  const lng = num(payload.longitude, "longitude");
  const accuracy = num(payload.accuracy_m, "accuracy_m");
  const isMocked = payload.is_mocked === true;

  const db = adminClient();

  // 1. Single-use, unexpired challenge belonging to this user.
  const expectedNonce = await consumeChallenge(db, user.id, challengeId, "checkin");
  if (nonce !== expectedNonce) {
    throw new HttpError(400, "challenge_invalid", "This request expired. Please try again.");
  }

  // 2. Signed by this user's active, approved phone.
  const { data: device, error: devErr } = await db
    .from("devices")
    .select("id, public_key")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (devErr) throw devErr;
  if (!device) {
    throw new HttpError(403, "no_device", "This phone isn't approved for check-in yet.");
  }
  if (!(await verifySignature(device.public_key, payloadText, signature))) {
    throw new HttpError(403, "bad_signature", "Could not verify this phone. Ask an admin to re-approve it.");
  }

  // 3. Location rules.
  if (isMocked) {
    throw new HttpError(403, "mock_location", "Fake-location apps must be turned off to check in.");
  }
  if (accuracy <= 0 || accuracy > MAX_ACCURACY_M) {
    throw new HttpError(
      422,
      "low_accuracy",
      `Location isn't precise enough (±${Math.round(accuracy)} m). Move near a window or outdoors and try again.`,
    );
  }

  const { data: site, error: siteErr } = await db
    .from("sites")
    .select("id, name, latitude, longitude, radius_m, active")
    .eq("id", siteId)
    .maybeSingle();
  if (siteErr) throw siteErr;
  if (!site || !site.active) throw new HttpError(404, "no_site", "Unknown location.");

  const distance = distanceMeters(lat, lng, site.latitude, site.longitude);
  if (distance > site.radius_m) {
    throw new HttpError(
      403,
      "out_of_range",
      `You're about ${Math.round(distance)} m from ${site.name}. Get within ${site.radius_m} m to check in.`,
    );
  }

  // 4. Record it (once per person, per site, per day).
  const { data, error } = await db
    .from("attendance")
    .insert({
      user_id: user.id,
      site_id: site.id,
      device_id: device.id,
      latitude: lat,
      longitude: lng,
      accuracy_m: accuracy,
      distance_m: distance,
      check_in_date: localDate(TIME_ZONE),
    })
    .select("id, checked_in_at")
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new HttpError(409, "already_checked_in", `You've already checked in at ${site.name} today.`);
    }
    throw error;
  }

  return json({
    attendance_id: data.id,
    checked_in_at: data.checked_in_at,
    site_name: site.name,
    distance_m: Math.round(distance),
  });
}));
