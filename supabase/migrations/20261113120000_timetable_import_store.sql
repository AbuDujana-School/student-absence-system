-- Versioned timetable imports and append-only change history.
-- Apply only to an isolated development database after review; never run on production during this phase.

create table if not exists public.timetable_imports (
  id uuid primary key default gen_random_uuid(),
  version integer not null default 1 check (version > 0),
  parent_import_id uuid references public.timetable_imports(id) on delete restrict,
  file_name text not null check (length(btrim(file_name)) > 0),
  imported_by_type text not null check (imported_by_type = 'admin'),
  imported_by_name text not null check (length(btrim(imported_by_name)) > 0),
  status text not null default 'draft'
    check (status in ('draft','reviewed','approved','active','superseded','rejected')),
  has_weekly_placements boolean not null default false,
  source_sheets text[] not null default '{}',
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  reference_data jsonb not null default '{}'::jsonb check (jsonb_typeof(reference_data) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists timetable_imports_created_at_idx
  on public.timetable_imports (created_at desc);
create index if not exists timetable_imports_status_idx
  on public.timetable_imports (status, created_at desc);

create table if not exists public.timetable_import_teachers (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.timetable_imports(id) on delete cascade,
  source_name text not null check (length(btrim(source_name)) > 0),
  normalized_name text not null,
  matched_teacher_name text,
  match_status text not null check (match_status in ('matched','unmatched','ambiguous')),
  aliases jsonb not null default '[]'::jsonb check (jsonb_typeof(aliases) = 'array'),
  created_at timestamptz not null default now()
);

create index if not exists timetable_import_teachers_import_idx
  on public.timetable_import_teachers (import_id, source_name);

create table if not exists public.timetable_import_records (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.timetable_imports(id) on delete cascade,
  import_teacher_id uuid references public.timetable_import_teachers(id) on delete set null,
  teacher_source_name text not null default '',
  source_sheet text not null,
  source_row integer not null check (source_row > 0),
  origin text not null default 'imported' check (origin in ('imported','manual')),
  record_data jsonb not null check (jsonb_typeof(record_data) = 'object'),
  weekday text,
  period integer check (period is null or period between 1 and 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (import_id, source_sheet, source_row)
);

create index if not exists timetable_import_records_teacher_idx
  on public.timetable_import_records (import_id, import_teacher_id, source_row);
create index if not exists timetable_import_records_placement_idx
  on public.timetable_import_records (import_id, weekday, period)
  where weekday is not null and period is not null;

create table if not exists public.timetable_import_audit (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.timetable_imports(id) on delete cascade,
  record_id uuid references public.timetable_import_records(id) on delete set null,
  action text not null check (action in ('import_created','record_updated','record_added','record_deleted','status_changed','reimport_compared')),
  actor_type text not null check (actor_type = 'admin'),
  actor_name text not null check (length(btrim(actor_name)) > 0),
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists timetable_import_audit_history_idx
  on public.timetable_import_audit (import_id, created_at desc);

alter table public.timetable_imports enable row level security;
alter table public.timetable_import_teachers enable row level security;
alter table public.timetable_import_records enable row level security;
alter table public.timetable_import_audit enable row level security;

revoke all on table public.timetable_imports from public, anon, authenticated;
revoke all on table public.timetable_import_teachers from public, anon, authenticated;
revoke all on table public.timetable_import_records from public, anon, authenticated;
revoke all on table public.timetable_import_audit from public, anon, authenticated;
grant all on table public.timetable_imports to service_role;
grant all on table public.timetable_import_teachers to service_role;
grant all on table public.timetable_import_records to service_role;
grant all on table public.timetable_import_audit to service_role;

create or replace function public.save_timetable_import(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_import_id uuid := gen_random_uuid();
  v_teacher jsonb;
  v_record jsonb;
  v_teacher_id uuid;
  v_record_count integer := 0;
  v_teacher_count integer := 0;
  v_sheets text[];
  v_result jsonb;
  v_file_name text;
  v_actor text;
  v_unassigned jsonb;
begin
  if jsonb_typeof(p_payload) <> 'object'
    or jsonb_typeof(p_payload->'result') <> 'object'
    or jsonb_typeof(p_payload->'result'->'teachers') <> 'array'
    or jsonb_typeof(p_payload->'result'->'sourceSheets') <> 'array'
    or jsonb_typeof(p_payload->'result'->'referenceData') <> 'object' then
    raise exception 'Invalid timetable import payload';
  end if;

  if jsonb_array_length(p_payload->'result'->'teachers') > 500 then
    raise exception 'Timetable teacher limit exceeded';
  end if;

  v_file_name := left(btrim(coalesce(p_payload->>'file_name','')),180);
  v_actor := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  if v_file_name = '' or v_actor = '' then
    raise exception 'Missing timetable import metadata';
  end if;

  select coalesce(array_agg(value), '{}')
    into v_sheets
    from jsonb_array_elements_text(p_payload->'result'->'sourceSheets');

  insert into public.timetable_imports (
    id, version, file_name, imported_by_type, imported_by_name, status,
    has_weekly_placements, source_sheets, summary, reference_data
  ) values (
    v_import_id, 1, v_file_name, 'admin', v_actor, 'draft',
    coalesce((p_payload->'result'->>'hasWeeklyPlacements')::boolean,false),
    v_sheets, coalesce(p_payload->'result'->'totals','{}'::jsonb),
    p_payload->'result'->'referenceData'
  );

  for v_teacher in select value from jsonb_array_elements(p_payload->'result'->'teachers')
  loop
    if coalesce(btrim(v_teacher->>'sourceName'),'') = ''
      or coalesce(v_teacher->>'matchStatus','') not in ('matched','unmatched','ambiguous')
      or jsonb_typeof(v_teacher->'records') <> 'array'
      or jsonb_typeof(v_teacher->'aliases') <> 'array' then
      raise exception 'Invalid timetable teacher row';
    end if;

    insert into public.timetable_import_teachers (
      import_id, source_name, normalized_name, matched_teacher_name,
      match_status, aliases
    ) values (
      v_import_id,
      left(btrim(v_teacher->>'sourceName'),200),
      left(coalesce(v_teacher->>'normalizedName',''),240),
      nullif(left(btrim(coalesce(v_teacher->>'matchedTeacherName','')),200),''),
      v_teacher->>'matchStatus',
      v_teacher->'aliases'
    ) returning id into v_teacher_id;

    v_teacher_count := v_teacher_count + 1;
    for v_record in select value from jsonb_array_elements(v_teacher->'records')
    loop
      if coalesce(v_record->>'sourceSheet','') = ''
        or coalesce((v_record->>'sourceRow')::integer,0) < 1
        or jsonb_typeof(v_record->'raw') <> 'object' then
        raise exception 'Invalid timetable lesson record';
      end if;
      insert into public.timetable_import_records (
        import_id, import_teacher_id, teacher_source_name, source_sheet,
        source_row, origin, record_data, weekday, period
      ) values (
        v_import_id, v_teacher_id,
        left(coalesce(v_record->>'teacherSourceName',''),200),
        left(v_record->>'sourceSheet',120),
        (v_record->>'sourceRow')::integer,
        'imported', v_record,
        nullif(v_record->>'weekday',''),
        nullif(v_record->>'period','')::integer
      ) on conflict (import_id, source_sheet, source_row) do nothing;
      if found then v_record_count := v_record_count + 1; end if;
    end loop;
  end loop;

  -- Preserve rows without a safe teacher association, including ambiguous aliases.
  v_unassigned := coalesce(p_payload->'result'->'unassignedRecords','[]'::jsonb);
  if jsonb_typeof(v_unassigned) = 'array' then
    for v_record in select value from jsonb_array_elements(v_unassigned)
    loop
      if coalesce(v_record->>'sourceSheet','') = ''
        or coalesce((v_record->>'sourceRow')::integer,0) < 1
        or jsonb_typeof(v_record->'raw') <> 'object' then
        raise exception 'Invalid unassigned timetable record';
      end if;
      insert into public.timetable_import_records (
        import_id, import_teacher_id, teacher_source_name, source_sheet,
        source_row, origin, record_data, weekday, period
      ) values (
        v_import_id, null,
        left(coalesce(v_record->>'teacherSourceName',''),200),
        left(v_record->>'sourceSheet',120),
        (v_record->>'sourceRow')::integer,
        'imported', v_record,
        nullif(v_record->>'weekday',''),
        nullif(v_record->>'period','')::integer
      ) on conflict (import_id, source_sheet, source_row) do nothing;
      if found then v_record_count := v_record_count + 1; end if;
    end loop;
  end if;

  insert into public.timetable_import_audit (
    import_id, action, actor_type, actor_name, after_data
  ) values (
    v_import_id, 'import_created', 'admin', v_actor,
    jsonb_build_object('file_name',v_file_name,'teacher_count',v_teacher_count,'record_count',v_record_count,'status','draft')
  );

  return jsonb_build_object(
    'import_id',v_import_id,'version',1,'status','draft',
    'teacher_count',v_teacher_count,'record_count',v_record_count
  );
end;
$function$;

revoke all on function public.save_timetable_import(jsonb) from public, anon, authenticated;
grant execute on function public.save_timetable_import(jsonb) to service_role;
