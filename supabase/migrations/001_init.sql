-- Job board schema. Run in the Supabase SQL Editor.
-- The browser (publishable key) can only read jobs and change status/notes, and only for
-- logged-in users listed in public.allowed_users. The pipeline writes with the secret key.
-- The allowed email is NOT seeded here (this repo is public); see scripts/seed_allowed_user.py.

create table if not exists public.jobs (
  id            text primary key,
  owner         text not null check (owner in ('devin', 'linda')),
  company       text,
  title         text not null,
  category      text check (category in ('fde', 'se', 'pm', 'ai-eng', 'fellows', 'other')),
  source        text,
  link          text,
  location      text,
  remote        boolean,
  pay_min       integer,
  pay_max       integer,
  pay_text      text,
  status        text not null default 'lead' check (status in
                  ('lead', 'tailored', 'applied', 'screening', 'interview', 'offer',
                   'rejected', 'withdrawn', 'skipped')),
  date_found    date,
  date_applied  date,
  resume_path   text,
  referral      text,
  fit_notes     text,
  notes         text,
  description   text,
  details       jsonb,                -- questions, talkingPoints, themes, assessmentPrep
  fit_score     numeric,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (owner, link)                -- dedupe; rows without a link are keyed by id
);

create index if not exists jobs_owner_status_idx on public.jobs (owner, status);

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists jobs_set_updated_at on public.jobs;
create trigger jobs_set_updated_at before update on public.jobs
  for each row execute function public.set_updated_at();

-- Who may use the board.
create table if not exists public.allowed_users (
  email text primary key
);
alter table public.allowed_users enable row level security;   -- no policies: not readable from the API

create or replace function public.is_allowed_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.allowed_users
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

alter table public.jobs enable row level security;

drop policy if exists "allowed users read jobs" on public.jobs;
create policy "allowed users read jobs" on public.jobs
  for select to authenticated using (public.is_allowed_user());

drop policy if exists "allowed users update jobs" on public.jobs;
create policy "allowed users update jobs" on public.jobs
  for update to authenticated using (public.is_allowed_user()) with check (public.is_allowed_user());

-- No anon access; browser can read, and update only status and notes. No insert/delete.
revoke all on public.jobs from anon, authenticated;
revoke all on public.allowed_users from anon, authenticated;
grant select on public.jobs to authenticated;
grant update (status, notes) on public.jobs to authenticated;
revoke execute on function public.is_allowed_user() from public, anon;
grant execute on function public.is_allowed_user() to authenticated;
