-- Marks postings that have disappeared from their ATS board. The row stays; the board hides it by default.
alter table public.jobs add column if not exists closed boolean not null default false;
create index if not exists jobs_closed_idx on public.jobs (closed);
