-- Jester: the shared round log for the eval suite (eval/README.md).
-- One row per scored round from a dev server: pose data only (no video, no images, no masks).
-- `npm run upload` adds rows and `npm run pull` reads them, both with the page's public key.
-- Rows are never changed or deleted with that key: an upload skips ids already there.

create table public.rounds (
  id text primary key check (id ~ '^r-[a-z0-9]{6,12}-[a-z0-9]{6}$'),
  created_at timestamptz not null default now(),
  scorer_version text not null,
  mode text,
  tag text,
  clip_key text,
  score int,
  -- The whole round record (eval/src/record.ts), about 0.5 MB for a 20 second round.
  record jsonb not null
);

alter table public.rounds enable row level security;

-- New tables no longer get grants automatically: the page's key may read and add rows, nothing else.
grant select, insert on public.rounds to anon, authenticated;

create policy "anyone adds rounds"
  on public.rounds for insert
  to anon, authenticated
  with check (true);

create policy "anyone reads rounds"
  on public.rounds for select
  to anon, authenticated
  using (true);
