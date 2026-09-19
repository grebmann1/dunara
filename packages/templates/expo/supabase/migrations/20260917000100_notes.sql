-- App database only. Apply once through Backend review before using /account notes.
begin;
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index notes_owner_created on public.notes(owner_id, created_at desc);
alter table public.notes enable row level security;
revoke all on public.notes from anon, authenticated;
grant select, insert, delete on public.notes to authenticated;
grant update (body) on public.notes to authenticated;
create policy notes_read on public.notes for select to authenticated using (owner_id = (select auth.uid()));
create policy notes_create on public.notes for insert to authenticated with check (owner_id = (select auth.uid()));
create policy notes_edit on public.notes for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy notes_delete on public.notes for delete to authenticated using (owner_id = (select auth.uid()));
commit;
