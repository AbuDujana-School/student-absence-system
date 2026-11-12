-- Official Student Affairs notice ledger.
-- Isolated, append-only history; existing attendance, behavior, student, teacher and permission data are untouched.
create table if not exists public.student_affairs_notice_issues (
  id uuid primary key default gen_random_uuid(),
  class_name text not null check (length(btrim(class_name)) > 0),
  student_name text not null check (length(btrim(student_name)) > 0),
  issue_number integer not null check (issue_number > 0),
  issued_on date not null,
  issued_at timestamptz not null default now(),
  issued_by_type text not null check (issued_by_type in ('admin', 'teacher', 'custom')),
  issued_by_name text not null check (length(btrim(issued_by_name)) > 0),
  delivered boolean not null default false,
  delivered_at timestamptz,
  threshold smallint not null check (threshold between 1 and 10),
  period_start date,
  period_end date not null,
  selected_types jsonb not null check (jsonb_typeof(selected_types) = 'array'),
  events jsonb not null check (jsonb_typeof(events) = 'array' and jsonb_array_length(events) > 0),
  constraint student_affairs_notice_issues_student_number_uq unique (class_name, student_name, issue_number),
  constraint student_affairs_notice_issues_period_ck check (period_start is null or period_start <= period_end),
  constraint student_affairs_notice_issues_delivery_ck check (
    (delivered = false and delivered_at is null) or
    (delivered = true and delivered_at is not null)
  )
);

create index if not exists student_affairs_notice_issues_student_history_idx
  on public.student_affairs_notice_issues (class_name, student_name, issued_at desc);

create index if not exists student_affairs_notice_issues_issued_on_idx
  on public.student_affairs_notice_issues (issued_on desc);

alter table public.student_affairs_notice_issues enable row level security;
revoke all on table public.student_affairs_notice_issues from public, anon, authenticated;
grant select, insert on table public.student_affairs_notice_issues to service_role;

create or replace function public.issue_student_affairs_notices(p_items jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  v_item jsonb;
  v_result jsonb := '[]'::jsonb;
  v_row public.student_affairs_notice_issues%rowtype;
  v_class text;
  v_student text;
  v_next_number integer;
  v_delivered boolean;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 1000 then
    raise exception 'Invalid notice batch';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_class := btrim(coalesce(v_item->>'class_name', ''));
    v_student := btrim(coalesce(v_item->>'student_name', ''));
    v_delivered := coalesce((v_item->>'delivered')::boolean, false);

    if v_class = '' or v_student = ''
      or coalesce(v_item->>'issued_by_name', '') = ''
      or coalesce(v_item->>'issued_by_type', '') not in ('admin', 'teacher', 'custom')
      or jsonb_typeof(v_item->'events') <> 'array'
      or jsonb_array_length(v_item->'events') < 1
      or jsonb_typeof(v_item->'selected_types') <> 'array'
      or (v_item->>'threshold')::integer not between 1 and 10
      or (v_item->>'period_end')::date < (v_item->>'issued_on')::date then
      raise exception 'Invalid notice item';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(v_class || chr(31) || v_student, 0));
    select coalesce(max(issue_number), 0) + 1
      into v_next_number
      from public.student_affairs_notice_issues
      where class_name = v_class and student_name = v_student;

    insert into public.student_affairs_notice_issues (
      class_name, student_name, issue_number, issued_on, issued_by_type, issued_by_name,
      delivered, delivered_at, threshold, period_start, period_end, selected_types, events
    ) values (
      v_class, v_student, v_next_number, (v_item->>'issued_on')::date,
      v_item->>'issued_by_type', btrim(v_item->>'issued_by_name'),
      v_delivered, case when v_delivered then now() else null end,
      (v_item->>'threshold')::smallint,
      nullif(v_item->>'period_start', '')::date,
      (v_item->>'period_end')::date,
      v_item->'selected_types', v_item->'events'
    )
    returning * into v_row;

    v_result := v_result || jsonb_build_array(to_jsonb(v_row));
  end loop;

  return v_result;
end;
$function$;

revoke all on function public.issue_student_affairs_notices(jsonb) from public, anon, authenticated;
grant execute on function public.issue_student_affairs_notices(jsonb) to service_role;

comment on table public.student_affairs_notice_issues is
  'Append-only official student notice ledger. Test previews are never inserted here; source attendance and behavior records remain unchanged.';
comment on function public.issue_student_affairs_notices(jsonb) is
  'Atomically issues official notices and assigns the next number per student under a transaction-scoped advisory lock. Service-role only.';
