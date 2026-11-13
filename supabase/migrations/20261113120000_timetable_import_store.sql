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
  source_data jsonb check (source_data is null or jsonb_typeof(source_data) = 'object'),
  record_data jsonb not null check (jsonb_typeof(record_data) = 'object'),
  weekday text,
  period integer check (period is null or period between 1 and 20),
  modified_by text,
  modified_at timestamptz,
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
        source_row, origin, source_data, record_data, weekday, period
      ) values (
        v_import_id, v_teacher_id,
        left(coalesce(v_record->>'teacherSourceName',''),200),
        left(v_record->>'sourceSheet',120),
        (v_record->>'sourceRow')::integer,
        'imported', v_record, v_record,
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
        source_row, origin, source_data, record_data, weekday, period
      ) values (
        v_import_id, null,
        left(coalesce(v_record->>'teacherSourceName',''),200),
        left(v_record->>'sourceSheet',120),
        (v_record->>'sourceRow')::integer,
        'imported', v_record, v_record,
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


create or replace function public.mutate_timetable_import_record(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_mode text := coalesce(p_payload->>'mode','');
  v_import_id uuid := (p_payload->>'import_id')::uuid;
  v_record_id uuid := nullif(p_payload->>'record_id','')::uuid;
  v_actor text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_record public.timetable_import_records%rowtype;
  v_teacher_id uuid;
  v_teacher_name text;
  v_record_data jsonb := p_payload->'record_data';
  v_weekday text;
  v_period integer;
  v_class text;
  v_group text;
  v_room text;
  v_source_row integer;
begin
  if v_import_id is null or v_actor = '' or v_mode not in ('add','update','delete') then
    raise exception 'Invalid timetable record mutation';
  end if;

  perform 1 from public.timetable_imports
    where id = v_import_id and status = 'draft'
    for update;
  if not found then raise exception 'لا يمكن تعديل هذه النسخة؛ يجب أن تكون مسودة.'; end if;

  if v_mode in ('update','delete') then
    select * into v_record
      from public.timetable_import_records
      where id = v_record_id and import_id = v_import_id
      for update;
    if not found then raise exception 'سجل الحصة المطلوب غير موجود.'; end if;
  end if;

  if v_mode = 'delete' then
    insert into public.timetable_import_audit (
      import_id, record_id, action, actor_type, actor_name, before_data
    ) values (
      v_import_id, v_record.id, 'record_deleted', 'admin', v_actor, v_record.record_data
    );
    delete from public.timetable_import_records where id = v_record.id;
    return jsonb_build_object('ok',true,'mode','delete','record_id',v_record.id);
  end if;

  if jsonb_typeof(v_record_data) <> 'object' then
    raise exception 'بيانات الحصة غير صالحة.';
  end if;

  v_teacher_name := left(btrim(coalesce(v_record_data->>'teacherSourceName','')),200);
  if v_teacher_name = '' then raise exception 'يجب تحديد المعلم للحصة.'; end if;

  select count(*) into v_source_row
    from public.timetable_import_teachers t
   where t.import_id = v_import_id
     and t.match_status <> 'ambiguous'
     and lower(t.source_name) = lower(v_teacher_name);
  if v_source_row = 1 then
    select t.id into v_teacher_id
      from public.timetable_import_teachers t
     where t.import_id = v_import_id
       and t.match_status <> 'ambiguous'
       and lower(t.source_name) = lower(v_teacher_name)
     limit 1;
  elsif v_source_row > 1 then
    raise exception 'اسم المعلم غير مطابق أو ملتبس ضمن هذه النسخة.';
  else
    select count(*) into v_source_row
      from public.timetable_import_teachers t
     where t.import_id = v_import_id
       and t.match_status <> 'ambiguous'
       and exists (
         select 1 from jsonb_array_elements_text(t.aliases) alias(value)
          where lower(alias.value) = lower(v_teacher_name)
       );
    if coalesce(v_source_row,0) <> 1 then
      raise exception 'اسم المعلم غير مطابق أو ملتبس ضمن هذه النسخة.';
    end if;
    select t.id into v_teacher_id
      from public.timetable_import_teachers t
     where t.import_id = v_import_id
       and t.match_status <> 'ambiguous'
       and exists (
         select 1 from jsonb_array_elements_text(t.aliases) alias(value)
          where lower(alias.value) = lower(v_teacher_name)
       )
     limit 1;
  end if;

  v_weekday := nullif(btrim(coalesce(v_record_data->>'weekday','')),'');
  v_period := nullif(v_record_data->>'period','')::integer;
  if (v_weekday is null) <> (v_period is null) then
    raise exception 'يجب إدخال اليوم ورقم الحصة معاً أو تركهما فارغين معاً.';
  end if;
  if v_period is not null and v_period not between 1 and 20 then
    raise exception 'رقم الحصة خارج النطاق المسموح.';
  end if;

  v_class := nullif(btrim(coalesce(v_record_data->>'className','')),'');
  v_group := nullif(btrim(coalesce(v_record_data->>'groupName','')),'');
  v_room := nullif(btrim(coalesce(v_record_data->>'rooms','')),'');

  if v_weekday is not null then
    if exists (
      select 1 from public.timetable_import_records r
       where r.import_id = v_import_id
         and r.id is distinct from v_record_id
         and r.weekday = v_weekday and r.period = v_period
         and r.import_teacher_id = v_teacher_id
    ) then raise exception 'تعارض: المعلم لديه حصة أخرى في اليوم والفترة نفسيهما.'; end if;

    if v_class is not null and exists (
      select 1 from public.timetable_import_records r
       where r.import_id = v_import_id
         and r.id is distinct from v_record_id
         and r.weekday = v_weekday and r.period = v_period
         and lower(coalesce(r.record_data->>'className','')) = lower(v_class)
         and (
           lower(coalesce(r.record_data->>'groupName','')) = lower(coalesce(v_group,''))
           or lower(coalesce(r.record_data->>'groupName','')) = 'الفصل بالكامل'
           or lower(coalesce(v_group,'')) = 'الفصل بالكامل'
         )
    ) then raise exception 'تعارض: الشعبة أو مجموعتها مرتبطة بحصة أخرى في الفترة نفسها.'; end if;

    if v_room is not null and exists (
      select 1 from public.timetable_import_records r
       where r.import_id = v_import_id
         and r.id is distinct from v_record_id
         and r.weekday = v_weekday and r.period = v_period
         and lower(coalesce(r.record_data->>'rooms','')) = lower(v_room)
    ) then raise exception 'تعارض: الغرفة محجوزة في اليوم والفترة نفسيهما.'; end if;
  end if;

  if v_mode = 'update' then
    update public.timetable_import_records
       set import_teacher_id = v_teacher_id,
           teacher_source_name = v_teacher_name,
           record_data = v_record_data,
           weekday = v_weekday,
           period = v_period,
           origin = 'manual',
           modified_by = v_actor,
           modified_at = now(),
           updated_at = now()
     where id = v_record.id;
    insert into public.timetable_import_audit (
      import_id, record_id, action, actor_type, actor_name, before_data, after_data
    ) values (
      v_import_id, v_record.id, 'record_updated', 'admin', v_actor, v_record.record_data, v_record_data
    );
    return jsonb_build_object('ok',true,'mode','update','record_id',v_record.id);
  end if;

  select coalesce(max(source_row),0) + 1 into v_source_row
    from public.timetable_import_records
   where import_id = v_import_id and source_sheet = 'manual';
  insert into public.timetable_import_records (
    import_id, import_teacher_id, teacher_source_name, source_sheet,
    source_row, origin, source_data, record_data, weekday, period,
    modified_by, modified_at
  ) values (
    v_import_id, v_teacher_id, v_teacher_name, 'manual',
    v_source_row, 'manual', null, v_record_data, v_weekday, v_period,
    v_actor, now()
  ) returning * into v_record;
  insert into public.timetable_import_audit (
    import_id, record_id, action, actor_type, actor_name, after_data
  ) values (
    v_import_id, v_record.id, 'record_added', 'admin', v_actor, v_record_data
  );
  return jsonb_build_object('ok',true,'mode','add','record_id',v_record.id);
end;
$function$;

revoke all on function public.mutate_timetable_import_record(jsonb) from public, anon, authenticated;
grant execute on function public.mutate_timetable_import_record(jsonb) to service_role;
