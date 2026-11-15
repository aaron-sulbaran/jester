-- Jester: clip submissions for the video bank.
-- Anyone with the public page may offer a clip. Nobody but the project owner (dashboard, service role) may read,
-- list, change or delete a submission or its video. A person on the team reviews each one by hand.

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- Name of the object in the private "submissions" bucket: a random id plus the file type.
  video_path text not null unique
    check (video_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|webm|mov)$'),
  title text check (title is null or char_length(title) between 1 and 80),
  credit text check (credit is null or char_length(credit) between 1 and 60),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected'))
);

alter table public.submissions enable row level security;

-- The page's key may only add a row, and only these three columns; id, time and status take their defaults.
revoke all on public.submissions from anon, authenticated;
grant insert (video_path, title, credit) on public.submissions to anon, authenticated;

-- The owner's server-side key may read and review rows (found by the second-model review: new tables no longer
-- get this grant automatically).
grant select, update, delete on public.submissions to service_role;

create policy "anyone may offer a pending clip"
  on public.submissions for insert
  to anon, authenticated
  with check (status = 'pending');

-- No select, update or delete policy on purpose: rows are readable only with the service role.

-- A private bucket for the videos: 25 MB each, video files only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('submissions', 'submissions', false, 26214400, array['video/mp4', 'video/webm', 'video/quicktime'])
on conflict (id) do nothing;

create policy "anyone may upload a submission video"
  on storage.objects for insert
  to anon, authenticated
  with check (
    bucket_id = 'submissions'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|webm|mov)$'
  );

-- No select, update or delete policy on storage.objects for this bucket: uploads cannot be read back,
-- listed, replaced or removed with the page's key.
