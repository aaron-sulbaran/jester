-- Jester: the round log for the eval suite. This is development data and is public on purpose (Aaron's call for
-- the hackathon): anyone with the page's key may add rounds and read them. Nobody may change or delete a round
-- with that key. Pose data only: no video and no photos.

create table public.rounds (
  id text primary key check (id ~ '^r-[a-z0-9]{6,12}-[a-z0-9]{6}$'),
  created_at timestamptz not null default now(),
  scorer_version text not null,
  mode text,
  tag text,
  clip_key text,
  score int,
  record jsonb not null
);

alter table public.rounds enable row level security;

-- New tables no longer get these grants automatically.
revoke all on public.rounds from anon, authenticated;
grant select, insert on public.rounds to anon, authenticated;
grant select, insert, update, delete on public.rounds to service_role;

create policy "anyone adds rounds" on public.rounds for insert to anon, authenticated with check (true);
create policy "anyone reads rounds" on public.rounds for select to anon, authenticated using (true);

-- No update or delete policy: a saved round cannot be altered or removed with the page's key.
