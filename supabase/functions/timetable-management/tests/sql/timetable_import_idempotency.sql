-- Integration regression test. Runs only against the disposable PostgreSQL service in CI.
begin;

do $test$
declare
  v_key uuid := gen_random_uuid();
  v_new_key uuid := gen_random_uuid();
  v_hash text := repeat('a', 64);
  v_payload jsonb;
  v_first jsonb;
  v_retry jsonb;
  v_new_import jsonb;
  v_import_id uuid;
  v_count integer;
begin
  v_payload := jsonb_build_object(
    'file_name', 'idempotency-test.xlsx',
    'actor_name', 'Isolated Test Admin',
    'idempotency_key', v_key::text,
    'request_hash', v_hash,
    'result', jsonb_build_object(
      'teachers', jsonb_build_array(jsonb_build_object(
        'sourceName', 'Test Teacher',
        'normalizedName', 'test teacher',
        'matchStatus', 'unmatched',
        'aliases', '[]'::jsonb,
        'records', jsonb_build_array(jsonb_build_object(
          'sourceSheet', 'Lessons',
          'sourceRow', 2,
          'teacherSourceName', 'Test Teacher',
          'raw', '{}'::jsonb,
          'weekday', 'الأحد',
          'period', '1'
        ))
      )),
      'sourceSheets', jsonb_build_array('Lessons'),
      'referenceData', '{}'::jsonb,
      'totals', '{}'::jsonb,
      'unassignedRecords', '[]'::jsonb
    )
  );

  v_first := public.save_timetable_import(v_payload);
  v_retry := public.save_timetable_import(v_payload);
  v_import_id := (v_first->>'import_id')::uuid;

  if v_first->>'import_id' is distinct from v_retry->>'import_id' then
    raise exception 'Retry created a different timetable import';
  end if;
  if coalesce((v_retry->>'replayed')::boolean, false) is not true then
    raise exception 'Retry did not report replayed=true';
  end if;

  select count(*) into v_count from public.timetable_imports where id = v_import_id;
  if v_count <> 1 then raise exception 'Expected exactly one import row after retry'; end if;
  select count(*) into v_count from public.timetable_import_teachers where import_id = v_import_id;
  if v_count <> 1 then raise exception 'Retry duplicated timetable teacher rows'; end if;
  select count(*) into v_count from public.timetable_import_records where import_id = v_import_id;
  if v_count <> 1 then raise exception 'Retry duplicated timetable lesson records'; end if;
  select count(*) into v_count from public.timetable_import_audit
   where import_id = v_import_id and action = 'import_created';
  if v_count <> 1 then raise exception 'Retry duplicated import audit entries'; end if;

  -- Reusing a key for different content must be rejected, not silently replayed.
  begin
    perform public.save_timetable_import(
      jsonb_set(v_payload, '{request_hash}', to_jsonb(repeat('b', 64)))
    );
    raise exception 'Expected idempotency key content mismatch to be rejected';
  exception when others then
    if position('reused with different content' in sqlerrm) = 0 then
      raise;
    end if;
  end;

  -- A deliberate new import gets a new key and therefore a new draft.
  v_new_import := public.save_timetable_import(
    jsonb_set(v_payload, '{idempotency_key}', to_jsonb(v_new_key::text))
  );
  if v_new_import->>'import_id' = v_first->>'import_id' then
    raise exception 'A new idempotency key did not create a new import';
  end if;
  if coalesce((v_new_import->>'replayed')::boolean, true) is not false then
    raise exception 'A new import unexpectedly reported replayed=true';
  end if;
end;
$test$;

rollback;
