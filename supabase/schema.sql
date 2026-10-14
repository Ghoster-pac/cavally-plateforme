-- ===========================================================================
--  CAVALLY — schéma de la base de sauvegarde en ligne (Supabase / PostgreSQL)
--
--  À exécuter UNE FOIS dans Supabase :
--    Dashboard du projet → « SQL Editor » → New query → coller ce contenu → Run.
--
--  Ces tables forment une copie en ligne de la base locale SQLite.
--  L'accès se fait avec la clé « publishable » (publique) : la plateforme
--  elle-même étant ouverte (partage par lien, sans compte), la base de
--  sauvegarde l'est tout autant. Pour restreindre plus tard, remplacez la clé
--  par une clé « secret » côté serveur et durcissez les politiques ci-dessous.
-- ---------------------------------------------------------------------------

-- 1) Avancements (miroir de la table locale « entries »)
create table if not exists public.entries (
  lot        text    not null,
  row        integer not null,
  task       text    not null,
  field      text    not null,
  value      text,
  updated_by text,
  updated_at text,
  synced_at  timestamptz default now(),
  primary key (lot, row, task, field)
);

-- 2) Locaux personnalisés (ajouts / modifications)
create table if not exists public.custom_locals (
  lot         text    not null,
  row_num     integer not null,
  designation text    not null,
  niveau      text,
  created_by  text,
  created_at  text,
  primary key (lot, row_num)
);

-- 3) Locaux d'origine masqués / supprimés
create table if not exists public.deleted_locals (
  lot        text    not null,
  row_num    integer not null,
  deleted_by text,
  deleted_at text,
  primary key (lot, row_num)
);

-- 3bis) Locaux uniquement personnalisés (désignation/niveau modifiés)
--       (utile si vous voulez distinguer ajout et simple modification)
create table if not exists public.sync_meta (
  key        text primary key,
  value      text,
  updated_at timestamptz default now()
);

-- 4) Instantanés de sauvegarde (copies datées complètes)
create table if not exists public.backups (
  id         bigint generated always as identity primary key,
  created_at timestamptz default now(),
  kind       text,
  nb_entries integer,
  nb_locals  integer,
  payload    jsonb
);

-- ---------------------------------------------------------------------------
-- Droits d'accès et politiques (Row Level Security)
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.entries        to anon, authenticated;
grant select, insert, update, delete on public.custom_locals  to anon, authenticated;
grant select, insert, update, delete on public.deleted_locals to anon, authenticated;
grant select, insert, update, delete on public.sync_meta      to anon, authenticated;
grant select, insert, update, delete on public.backups        to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

alter table public.entries        enable row level security;
alter table public.custom_locals  enable row level security;
alter table public.deleted_locals enable row level security;
alter table public.sync_meta      enable row level security;
alter table public.backups        enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename='entries' and policyname='cavally_all') then
    create policy cavally_all on public.entries for all to anon, authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='custom_locals' and policyname='cavally_all') then
    create policy cavally_all on public.custom_locals for all to anon, authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='deleted_locals' and policyname='cavally_all') then
    create policy cavally_all on public.deleted_locals for all to anon, authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='sync_meta' and policyname='cavally_all') then
    create policy cavally_all on public.sync_meta for all to anon, authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='backups' and policyname='cavally_all') then
    create policy cavally_all on public.backups for all to anon, authenticated using (true) with check (true);
  end if;
end $$;

-- Force PostgREST à recharger son cache de schéma immédiatement
notify pgrst, 'reload schema';
