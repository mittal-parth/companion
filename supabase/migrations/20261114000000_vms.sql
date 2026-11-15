-- The record of each user's cloud computer. One row per user, because a user
-- has exactly one computer; no row means none was requested yet.
--
-- Only our server touches this table, using the secret key, which skips
-- row-level security. The browser roles get no access, in two layers:
-- their privileges are revoked, and row-level security is on with no policies.
-- It is its own table, not part of `profiles`, so profile fields that a person
-- may read or edit never share a row with this record.
create table public.vms (
  user_id uuid primary key references auth.users (id) on delete cascade,
  state text not null check (state in ('launching', 'booting', 'ready', 'failed')),
  instance_id text,
  -- when the current attempt was claimed; it names the attempt everywhere else
  attempt_started_at timestamptz not null
);

alter table public.vms enable row level security;

-- Some projects grant new `public` tables to the browser roles by default, and
-- some grant nothing. Be explicit either way: take it back from the browser
-- roles, and give the server's role (the secret key) what it needs.
revoke all on table public.vms from anon, authenticated;
grant select, insert, update on table public.vms to service_role;
