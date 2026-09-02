-- Autorise le statut `queued` sur les demandes musicales.
-- Conserve `played` en legacy pour éviter de casser des usages existants.
do $$
declare
  c record;
begin
  if not exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'song_requests'
  ) then
    return;
  end if;

  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'song_requests'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%status%'
  loop
    execute format('alter table public.song_requests drop constraint %I', c.conname);
  end loop;

  alter table public.song_requests
    add constraint song_requests_status_check
    check (status in ('pending', 'queued', 'rejected', 'played'));
end
$$;
