-- Server-side idempotency for timetable draft imports.
-- Safe to review and test only on an isolated development database.
-- Existing imports remain unchanged; legacy rows keep a NULL idempotency key.

alter table public.timetable_imports
  add column if not exists idempotency_key uuid,
  add column if not exists request_hash text;

create unique index if not exists timetable_imports_idempotency_key_uidx
  on public.timetable_imports (idempotency_key)
  where idempotency_key is not null;

create or replace function public.save_timetable_import(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_import_id uuid := gen_random_uuid();
  v_idempotency_key uuid;
  v_request_hash text;
  v_existing public.timetable_imports%rowtype;
  v_teacher jsonb;
  v_record jsonb;
  v_teacher_id uuid;
  v_record_count integer := 0;
  v_teacher_count integer := 0;
  v_sheets text[];
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

  v_idempotency_key := nullif(p_payload->>'idempotency_key','')::uuid;
  v_request_hash := coalesce(p_payload->>'request_hash','');
  if v_idempotency_key is null or v_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Missing or invalid timetable import idempotency metadata';
  end if;

  select coalesce(array_agg(value), '{}')
    into v_sheets
    from jsonb_array_elements_text(p_payload->'result'->'sourceSheets');

  v_import_id := null;
  insert into public.timetable_imports (
    version, idempotency_key, request_hash,
    file_name, imported_by_type, imported_by_name, status,
    has_weekly_placements, source_sheets, summary, reference_data
  ) values (
    1, v_idempotency_key, v_request_hash,
    v_file_name, 'admin', v_actor, 'draft',
    coalesce((p_payload->'result'->>'hasWeeklyPlacements')::boolean,false),
    v_sheets, coalesce(p_payload->'result'->'totals','{}'::jsonb),
    p_payload->'result'->'referenceData'
  )
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning id into v_import_id;

  -- A retry with the same key returns the already-created draft. It never
  -- inserts teachers, records, or audit rows a second time.
  if v_import_id is null then
    select * into v_existing
      from public.timetable_imports
     where idempotency_key = v_idempotency_key
     for update;

    if not found then
      raise exception 'Unable to resolve timetable import idempotency key';
    end if;
    if v_existing.request_hash is distinct from v_request_hash then
      raise exception 'Timetable import idempotency key was reused with different content';
    end if;

    select count(*)::integer into v_teacher_count
      from public.timetable_import_teachers where import_id = v_existing.id;
    select count(*)::integer into v_record_count
      from public.timetable_import_records where import_id = v_existing.id;

    return jsonb_build_object(
      'import_id',v_existing.id,'version',v_existing.version,
      'status',v_existing.status,'teacher_count',v_teacher_count,
      'record_count',v_record_count,'replayed',true
    );
  end if;

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
      matched_department_id, matched_department_name, match_status, aliases
    ) values (
      v_import_id,
      left(btrim(v_teacher->>'sourceName'),200),
      left(coalesce(v_teacher->>'normalizedName',''),240),
      nullif(left(btrim(coalesce(v_teacher->>'matchedTeacherName','')),200),''),
      nullif(left(btrim(coalesce(v_teacher->>'matchedDepartmentId','')),160),''),
      nullif(left(btrim(coalesce(v_teacher->>'matchedDepartmentName','')),160),''),
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
    'teacher_count',v_teacher_count,'record_count',v_record_count,
    'replayed',false
  );
end;
$function$;

revoke all on function public.save_timetable_import(jsonb) from public, anon, authenticated;
grant execute on function public.save_timetable_import(jsonb) to service_role;
