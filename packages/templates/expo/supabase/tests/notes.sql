\set ON_ERROR_STOP on
-- Only run in a disposable app database, never in a live environment.
begin;
insert into auth.users(id) values ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111', true);
insert into public.notes(id,body) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'My private note');
do $$ begin
  if (select body from public.notes) <> 'My private note' then raise exception 'Owner cannot read'; end if;
  update public.notes set body = 'Updated note';
  if (select body from public.notes) <> 'Updated note' then raise exception 'Owner cannot update'; end if;
  begin
    insert into public.notes(owner_id, body) values ('22222222-2222-4222-8222-222222222222', 'Forged owner');
    raise exception 'Forged insert allowed';
  exception when insufficient_privilege then null; end;
  begin
    update public.notes set owner_id = '22222222-2222-4222-8222-222222222222';
    raise exception 'Owner reassignment allowed';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222', true);
do $$ begin
  if exists(select 1 from public.notes) then raise exception 'Private note leaked'; end if;
  update public.notes set body = 'Stolen';
  if found then raise exception 'Foreign update allowed'; end if;
  delete from public.notes;
  if found then raise exception 'Foreign deletion allowed'; end if;
  insert into public.notes(body) values ('Second owner note');
  if (select count(*) from public.notes) <> 1 then raise exception 'Second owner isolation failed'; end if;
end $$;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111', true);
do $$ begin
  if (select body from public.notes) <> 'Updated note' then raise exception 'Original note changed'; end if;
  delete from public.notes;
  if not found then raise exception 'Owner delete failed'; end if;
end $$;
set local role anon;
do $$ begin
  begin perform * from public.notes; raise exception 'Anonymous read'; exception when insufficient_privilege then null; end;
  begin insert into public.notes(body) values ('Anonymous'); raise exception 'Anonymous write'; exception when insufficient_privilege then null; end;
end $$;
rollback;
select 'App note ownership policies passed' as result;
