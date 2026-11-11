import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2.49.4";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Service-role client: bypasses RLS. Only ever used inside Edge Functions. */
export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

/** The signed-in user who called this function, from their access token. */
export async function requireUser(req: Request): Promise<User> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "unauthenticated", "Sign in first.");
  const { data, error } = await adminClient().auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "unauthenticated", "Sign in again.");
  return data.user;
}

/** Wrap a handler with POST-only, JSON parsing and error mapping. */
export function handler(
  fn: (req: Request, body: Record<string, unknown>) => Promise<Response>,
) {
  return async (req: Request): Promise<Response> => {
    try {
      if (req.method !== "POST") {
        throw new HttpError(405, "method_not_allowed", "Use POST.");
      }
      let body: Record<string, unknown> = {};
      const text = await req.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new HttpError(400, "bad_json", "Body must be JSON.");
        }
      }
      return await fn(req, body);
    } catch (e) {
      if (e instanceof HttpError) {
        return json({ error: e.code, message: e.message }, e.status);
      }
      console.error(e);
      return json({ error: "server_error", message: "Something went wrong." }, 500);
    }
  };
}

export function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 4096) {
    throw new HttpError(400, "bad_request", `Missing or invalid "${name}".`);
  }
  return v;
}

export function num(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new HttpError(400, "bad_request", `Missing or invalid "${name}".`);
  }
  return v;
}

/**
 * Atomically mark a challenge used and return its nonce. Fails if it does not
 * belong to this user, has the wrong purpose, was already used, or expired.
 */
export async function consumeChallenge(
  db: SupabaseClient,
  userId: string,
  challengeId: string,
  purpose: "register" | "checkin",
): Promise<string> {
  const { data, error } = await db
    .from("challenges")
    .update({ used_at: new Date().toISOString() })
    .eq("id", challengeId)
    .eq("user_id", userId)
    .eq("purpose", purpose)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("nonce")
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new HttpError(400, "challenge_invalid", "This request expired. Please try again.");
  }
  return data.nonce as string;
}
