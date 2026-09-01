-- ============================================================
-- GROG — Table comments (idempotent)
-- ============================================================

-- Table
create table if not exists public.comments (
  id          bigint generated always as identity primary key,
  guest_name  text,
  message     text not null,
  status      text not null default 'pending'
                constraint comments_status_check
                check (status in ('pending', 'approved', 'rejected')),
  created_at  timestamptz not null default now(),
  approved_at timestamptz,
  displayed_at timestamptz
);

-- Indexes
create index if not exists comments_created_at_idx  on public.comments (created_at desc);
create index if not exists comments_status_idx      on public.comments (status);
create index if not exists comments_approved_at_idx on public.comments (approved_at desc);

-- RLS
alter table public.comments enable row level security;

-- ── Policies (drop then recreate to stay idempotent) ────────────────────────

-- ANON INSERT (invités publics)
drop policy if exists "comments_anon_insert" on public.comments;
create policy "comments_anon_insert"
  on public.comments
  for insert
  to anon
  with check (true);

-- ANON SELECT (optionnel — uniquement les commentaires approuvés)
drop policy if exists "comments_anon_select_approved" on public.comments;
create policy "comments_anon_select_approved"
  on public.comments
  for select
  to anon
  using (status = 'approved');

-- ADMIN SELECT (tous les statuts — utile pour la modération et la TV)
drop policy if exists "comments_admin_select" on public.comments;
create policy "comments_admin_select"
  on public.comments
  for select
  to authenticated
  using (true);

-- ADMIN UPDATE (modération : approved / rejected)
drop policy if exists "comments_admin_update" on public.comments;
create policy "comments_admin_update"
  on public.comments
  for update
  to authenticated
  using (true)
  with check (true);
