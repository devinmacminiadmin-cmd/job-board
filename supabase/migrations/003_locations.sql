-- All cities/regions for one job (a role posted once per city is collapsed into a single row).
alter table public.jobs add column if not exists locations text[] not null default '{}';
