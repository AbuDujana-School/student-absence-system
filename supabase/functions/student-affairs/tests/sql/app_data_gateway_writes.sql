\set ON_ERROR_STOP on
-- Runs only in the isolated app_sync_test PostgreSQL database.
ALTER TABLE public.teachers
  ADD COLUMN IF NOT EXISTS pin_hash text,
  ADD COLUMN IF NOT EXISTS pin_salt text,
  ADD COLUMN IF NOT EXISTS must_change_pin boolean DEFAULT false;
ALTER TABLE public.duty_reports
  ADD COLUMN IF NOT EXISTS day_num text,
  ADD COLUMN IF NOT EXISTS period integer,
  ADD COLUMN IF NOT EXISTS class_name text,
  ADD COLUMN IF NOT EXISTS subject text,
  ADD COLUMN IF NOT EXISTS teacher_name text,
  ADD COLUMN IF NOT EXISTS reported_by text,
  ADD COLUMN IF NOT EXISTS reviewed_by text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

INSERT INTO public.teachers(name, role, permissions, pin_hash, pin_salt, must_change_pin)
VALUES ('Synthetic Teacher', 'teacher', '{"attendance":true}'::jsonb, repeat('a',64), repeat('b',32), false)
ON CONFLICT (name) DO UPDATE SET pin_hash=excluded.pin_hash, pin_salt=excluded.pin_salt;

INSERT INTO public.attendance(record_key,date_str,class_name,period,teacher_name,records)
VALUES ('gateway-owner-check','2026-11-20','5/1',1,'Synthetic Teacher','{"student":"present"}')
ON CONFLICT (record_key) DO UPDATE SET teacher_name=excluded.teacher_name, records=excluded.records;

-- The service role is the only caller of the SECURITY DEFINER RPCs.
DO $do$
BEGIN
  IF has_function_privilege('anon','public.app_data_gateway_write_records(text,jsonb,boolean)','EXECUTE')
    OR has_function_privilege('authenticated','public.app_data_gateway_write_records(text,jsonb,boolean)','EXECUTE')
    OR has_function_privilege('public','public.app_data_gateway_write_records(text,jsonb,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'browser roles can execute the generic data write RPC';
  END IF;
  IF NOT has_function_privilege('service_role','public.app_data_gateway_write_records(text,jsonb,boolean)','EXECUTE')
    OR has_function_privilege('anon','public.app_data_gateway_set_pin_record(text,text,text,text,boolean)','EXECUTE')
    OR has_function_privilege('authenticated','public.app_data_gateway_set_pin_record(text,text,text,text,boolean)','EXECUTE')
    OR has_function_privilege('public','public.app_data_gateway_set_pin_record(text,text,text,text,boolean)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.app_data_gateway_set_pin_record(text,text,text,text,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'PIN rotation RPC grants are not service-role-only';
  END IF;
END $do$;

SET ROLE service_role;
SELECT public.app_data_gateway_write_records(
  'attendance',
  '[{"record_key":"gateway-owner-check","date_str":"2026-11-20","class_name":"5/1","period":1,"teacher_name":"Synthetic Teacher","records":{"student":"late"}}]'::jsonb,
  false
);
DO $do$
BEGIN
  BEGIN
    PERFORM public.app_data_gateway_write_records(
      'attendance',
      '[{"record_key":"gateway-owner-check","date_str":"2026-11-20","class_name":"5/1","period":1,"teacher_name":"Other Teacher","records":{"student":"absent"}}]'::jsonb,
      false
    );
    RAISE EXCEPTION 'cross-teacher overwrite unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    PERFORM public.app_data_gateway_write_records(
      'students',
      '[{"class_name":"5/1","student_name":"Forbidden Student"}]'::jsonb,
      false
    );
    RAISE EXCEPTION 'teacher-level student roster write unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $do$;
SELECT public.app_data_gateway_write_records(
  'teachers',
  '[{"name":"Synthetic Teacher","role":"teacher","permissions":{"attendance":true},"must_change_pin":true}]'::jsonb,
  true
);
SELECT public.app_data_gateway_set_pin_record(
  'teacher','Synthetic Teacher',repeat('c',64),repeat('d',32),true
);
RESET ROLE;

DO $do$
DECLARE v_owner text; v_records jsonb; v_hash text; v_salt text; v_must_change boolean;
BEGIN
  SELECT teacher_name, records INTO v_owner, v_records
  FROM public.attendance WHERE record_key='gateway-owner-check';
  IF v_owner <> 'Synthetic Teacher' OR v_records <> '{"student":"late"}'::jsonb THEN
    RAISE EXCEPTION 'atomic ownership guard did not preserve the original record';
  END IF;
  SELECT pin_hash,pin_salt,must_change_pin INTO v_hash,v_salt,v_must_change
  FROM public.teachers WHERE name='Synthetic Teacher';
  IF v_hash <> repeat('c',64) OR v_salt <> repeat('d',32) OR v_must_change IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'dedicated PIN rotation did not update the expected account record';
  END IF;
  IF EXISTS (SELECT 1 FROM public.students WHERE student_name='Forbidden Student') THEN
    RAISE EXCEPTION 'non-admin roster write was not rejected';
  END IF;
END $do$;

-- The administrator PIN record is writable only through the dedicated credential RPC.
SET ROLE service_role;
SELECT public.app_data_gateway_set_pin_record(
  'admin','مدير النظام العام',repeat('e',64),repeat('f',32),false
);
RESET ROLE;
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.school_settings
    WHERE key='admin_pin'
      AND value->>'hash'=repeat('e',64)
      AND value->>'salt'=repeat('f',32)
  ) THEN
    RAISE EXCEPTION 'dedicated administrator PIN rotation did not persist';
  END IF;
END $do$;
SELECT 'isolated app data gateway atomic write and PIN boundary checks passed' AS result;
