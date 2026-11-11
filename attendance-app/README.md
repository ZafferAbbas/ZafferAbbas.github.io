# Attendance app (Flutter + Supabase)

A check-in app for Android and iOS where **each person checks in on their own phone**.
A check-in only counts if:

1. it's signed by a **key locked inside that phone's security chip** (Android Keystore / iOS Secure Enclave),
2. the person passed **Face ID / fingerprint** to use that key (required for every check-in),
3. the phone is the **one approved phone** registered to that person,
4. the phone's **GPS** puts them within the site's radius, with fake-GPS apps rejected, and
5. it's their **first check-in at that site today**.

The app has no face-recognition code of its own. It relies on the phone's built-in biometrics, which are certified and hardware-backed, the same way banking apps do.

```
app/        Flutter app (Android + iOS)
supabase/   Database schema + Edge Functions (server-side checks)
```

## How the security works

```
 Phone                                        Supabase
 ─────                                        ────────
 Register (once):
   create P-256 key in Secure Enclave/Keystore
   ── challenge? ───────────────────────────►  random nonce (2-min, single use)
   Face ID/fingerprint → sign {nonce, pubkey}
   ── register-device ─────────────────────►  verify signature, store public key
                                              1st phone → active; later phones → pending (admin approves)
 Check in:
   read GPS (+ Android "is mocked" flag)
   ── challenge? ───────────────────────────►  new nonce
   Face ID/fingerprint → sign {nonce, site, lat, lng, accuracy}
   ── check-in ────────────────────────────►  verify nonce, device, signature,
                                              mock flag, GPS accuracy, distance, once/day
                                              → insert attendance row
```

Why this is hard to cheat:

- **The private key can't be copied.** It never leaves the chip, so a check-in can't be done from another phone or an emulator.
- **"Biometric passed" can't be faked**, even on a rooted phone. The chip only produces a signature after a real biometric match.
- **Adding a new fingerprint or face to the phone destroys the key.** A friend can't enroll their own finger on your phone and check in for you.
- **A captured request can't be replayed.** Each signature covers a one-time nonce that expires after 2 minutes.
- **The app can't write to the database.** All writes go through the Edge Functions, which enforce every rule. Row-level security limits users to reading their own data.

## Setup

### 1. Supabase (free tier)

1. Create a project at [supabase.com](https://supabase.com).
2. Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then from `attendance-app/`:

   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase db push                       # creates tables, RLS, functions
   supabase secrets set ATTENDANCE_TIME_ZONE=Asia/Karachi MAX_ACCURACY_M=50
   supabase functions deploy challenge register-device check-in
   ```

   (Or paste `supabase/migrations/*.sql` into the dashboard's SQL editor.)

3. Add your locations in **SQL editor**:

   ```sql
   insert into sites (name, latitude, longitude, radius_m)
   values ('Head office', 24.8607, 67.0011, 100);
   ```

   Get the coordinates by long-pressing the spot in Google Maps. 100 m is a reasonable starting radius. Too small, and indoor GPS drift will cause false rejections.

4. Make yourself an admin after signing up in the app:

   ```sql
   update profiles set is_admin = true
   where id = (select id from auth.users where email = 'you@example.com');
   ```

### 2. App

```bash
cd app
flutter pub get
flutter run \
  --dart-define=SUPABASE_URL=https://<project-ref>.supabase.co \
  --dart-define=SUPABASE_KEY=<publishable key from Project Settings → API>
```

**Use a real phone.** The iOS Simulator has no Secure Enclave, and most Android emulators lack strong biometrics.

Before publishing, change the app ID (`com.example.attendance.attendance`) in `android/app/build.gradle.kts` and in the iOS bundle identifier in Xcode.

## Admin tasks (SQL editor)

```sql
-- Phones waiting for approval
select d.id, p.full_name, d.platform, d.created_at
from devices d join profiles p on p.id = d.user_id
where d.status = 'pending';

-- Approve one (revokes that person's previous phone)
select approve_device('<device id>');

-- Today's attendance
select p.full_name, s.name as site, a.checked_in_at, round(a.distance_m) as metres
from attendance a
join profiles p on p.id = a.user_id
join sites s on s.id = a.site_id
where a.check_in_date = current_date
order by a.checked_in_at;

-- Lost phone: block it
update devices set status = 'revoked' where id = '<device id>';
```

## Run the tests

```bash
cd app && flutter analyze && flutter test
deno test supabase/functions/_shared/      # signature + distance checks
```

## Known limits and next steps

- **GPS is the weakest link.** Android flags most fake-GPS apps, and the server rejects those readings. A rooted phone with a hidden location spoofer can still lie about where it is. This version doesn't detect mocked locations on iOS. Ways to harden it:
  - **Play Integrity (Android) and App Attest (iOS):** free, and they block rooted, jailbroken or modified phones. The server has to verify their results; that isn't built yet.
  - **Wi-Fi check:** only accept check-ins on the venue's network.
  - **Rotating QR code** at the entrance: the strongest proof of presence.
- **Handing over an unlocked phone.** If someone gives their phone to a friend and unlocks it with their own face for each check-in, that works. Spot checks or a QR code at the entrance limit this.
- **Privacy:** the app stores only the check-in location and time, never biometric data. Biometrics stay on the phone and the server never sees them. Still, tell users what's collected and why.
