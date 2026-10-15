-- Prepared migration only. Not applied to any database.
-- This archive is separate from the application's runtime case store.
begin;

create table public.refund_decision_packets (
  owner_id uuid not null references auth.users(id) on delete restrict,
  case_id text not null check (case_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  revision bigint not null check (revision between 0 and 9007199254740991),
  packet jsonb not null check (jsonb_typeof(packet) = 'object'),
  created_at timestamptz not null default now(),
  primary key (owner_id, case_id, revision)
);

alter table public.refund_decision_packets enable row level security;
alter table public.refund_decision_packets force row level security;
revoke all on table public.refund_decision_packets from public, anon, authenticated, service_role;
grant select on table public.refund_decision_packets to authenticated;
create policy owner_reads_archive on public.refund_decision_packets
  for select to authenticated using (owner_id = (select auth.uid()));

create function public.reject_refund_archive_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Archived decision packets cannot be updated or deleted.' using errcode = '55000';
end;
$$;
create trigger immutable_refund_archive
  before update or delete on public.refund_decision_packets
  for each row execute function public.reject_refund_archive_mutation();
revoke all on function public.reject_refund_archive_mutation() from public, anon, authenticated, service_role;

create function public.archive_refund_decision(p_case_id text, p_revision bigint, p_packet jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  reviewer uuid := auth.uid();
  saved public.refund_decision_packets%rowtype;
begin
  if reviewer is null then
    raise exception 'A signed-in reviewer is required.' using errcode = '28000';
  end if;
  if p_case_id is null or p_case_id !~ '^[A-Za-z0-9_-]{1,160}$'
     or p_revision is null or p_revision < 0 or p_revision > 9007199254740991
     or p_packet is null or pg_catalog.jsonb_typeof(p_packet) <> 'object'
     or pg_catalog.jsonb_typeof(p_packet -> 'case') is distinct from 'object'
     or p_packet #>> '{case,id}' is distinct from p_case_id
     or p_packet #> '{case,revision}' is distinct from pg_catalog.to_jsonb(p_revision)
     or pg_catalog.octet_length(p_packet::text) > 1048576 then
    raise exception 'The saved case identity, revision and packet must match.' using errcode = '22023';
  end if;

  insert into public.refund_decision_packets(owner_id, case_id, revision, packet)
    values (reviewer, p_case_id, p_revision, p_packet)
    on conflict (owner_id, case_id, revision) do nothing;
  select * into strict saved from public.refund_decision_packets
    where owner_id = reviewer and case_id = p_case_id and revision = p_revision;
  if saved.packet is distinct from p_packet then
    raise exception 'This case revision already contains a different packet.' using errcode = '23505';
  end if;
  return pg_catalog.jsonb_build_object(
    'owner_id', saved.owner_id, 'case_id', saved.case_id,
    'revision', saved.revision, 'created_at', saved.created_at, 'archived', true
  );
end;
$$;
revoke all on function public.archive_refund_decision(text, bigint, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.archive_refund_decision(text, bigint, jsonb) to authenticated;

commit;
