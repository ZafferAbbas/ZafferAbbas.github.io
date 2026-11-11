-- Attendance app schema.
--
-- Security model: the app never writes to these tables directly. All writes
-- (device registration, check-ins) go through Edge Functions that verify a
-- signature made by a biometric-locked key in the phone's secure hardware.
-- Clients can only READ their own rows (and the list of active sites).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.email));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- ------------------------------------------------------------------- sites
-- Places where people can check in. Manage these from the Supabase dashboard.
create table public.sites (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  latitude    double precision not null check (latitude between -90 and 90),
  longitude   double precision not null check (longitude between -180 and 180),
  radius_m    integer not null default 100 check (radius_m between 20 and 5000),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ----------------------------------------------------------------- devices
-- One phone per person. The phone's public key is stored here; the private
-- key never leaves the Secure Enclave / Android Keystore.
--
-- A person's first phone is activated automatically. Any later phone (new
-- phone, reinstall, new fingerprint enrolled) arrives as 'pending' and must be
-- approved by an admin, which stops people from registering a friend's phone.
create table public.devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  public_key   text not null,               -- base64 DER SubjectPublicKeyInfo (EC P-256)
  platform     text not null check (platform in ('android', 'ios')),
  status       text not null default 'pending' check (status in ('active', 'pending', 'revoked')),
  created_at   timestamptz not null default now(),
  approved_at  timestamptz,
  approved_by  uuid references auth.users (id)
);

create unique index devices_one_active_per_user  on public.devices (user_id) where status = 'active';
create unique index devices_one_pending_per_user on public.devices (user_id) where status = 'pending';
create unique index devices_public_key_unique    on public.devices (public_key);

-- Approve a pending device (admins only). Revokes the user's previous phone.
create or replace function public.approve_device(p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
begin
  -- auth.uid() is null when run from the Supabase SQL editor (as postgres).
  -- Through the API, only signed-in users can call this (anon is revoked).
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'admins only';
  end if;

  select user_id into v_user from public.devices
   where id = p_device_id and status = 'pending'
   for update;
  if v_user is null then
    raise exception 'no pending device with that id';
  end if;

  update public.devices set status = 'revoked'
   where user_id = v_user and status = 'active';
  update public.devices
     set status = 'active', approved_at = now(), approved_by = auth.uid()
   where id = p_device_id;
end;
$$;

-- -------------------------------------------------------------- challenges
-- Single-use random values the phone must sign. Stops replaying an old
-- signed check-in. Only Edge Functions (service role) touch this table.
create table public.challenges (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  nonce       text not null,
  purpose     text not null check (purpose in ('register', 'checkin')),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index challenges_user_idx on public.challenges (user_id, created_at desc);

-- -------------------------------------------------------------- attendance
create table public.attendance (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  site_id        uuid not null references public.sites (id),
  device_id      uuid not null references public.devices (id),
  latitude       double precision not null,
  longitude      double precision not null,
  accuracy_m     double precision not null,
  distance_m     double precision not null,
  check_in_date  date not null,             -- in the site's/organisation's time zone
  checked_in_at  timestamptz not null default now()
);

-- One check-in per person, per site, per day.
create unique index attendance_once_per_day
  on public.attendance (user_id, site_id, check_in_date);
create index attendance_site_date_idx on public.attendance (site_id, check_in_date);

-- --------------------------------------------------------------------- RLS
alter table public.profiles   enable row level security;
alter table public.sites      enable row level security;
alter table public.devices    enable row level security;
alter table public.challenges enable row level security;
alter table public.attendance enable row level security;

create policy "read own profile" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());

create policy "read active sites" on public.sites
  for select to authenticated using (active or public.is_admin());

create policy "read own devices" on public.devices
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

create policy "read own attendance" on public.attendance
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- challenges: no policies on purpose -> no client access at all.
-- No insert/update/delete policies anywhere -> clients cannot write.

revoke execute on function public.approve_device(uuid) from public, anon;
grant  execute on function public.approve_device(uuid) to authenticated;
