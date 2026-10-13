-- Tailoring queue + private resume storage.
alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add constraint jobs_status_check check (status in
  ('lead', 'queued', 'tailored', 'applied', 'screening', 'interview', 'offer', 'rejected', 'withdrawn', 'skipped'));
alter table public.jobs add column if not exists gaps text[] not null default '{}';
alter table public.jobs add column if not exists resume_url text;   -- storage path inside the "resumes" bucket

-- Private bucket. Only allowed users may read (via signed URLs); only the secret key (service role,
-- which bypasses RLS) may write: there is deliberately no insert/update/delete policy.
insert into storage.buckets (id, name, public) values ('resumes', 'resumes', false)
on conflict (id) do update set public = false;

drop policy if exists "allowed users read resumes" on storage.objects;
create policy "allowed users read resumes" on storage.objects
  for select to authenticated
  using (bucket_id = 'resumes' and public.is_allowed_user());

-- verification output
select 'constraint' as kind, pg_get_constraintdef(oid) as detail from pg_constraint
 where conrelid = 'public.jobs'::regclass and conname = 'jobs_status_check'
union all
select 'bucket', id || ' public=' || public::text from storage.buckets where id = 'resumes'
union all
select 'policy', policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') from pg_policies
 where schemaname = 'storage' and tablename = 'objects';
