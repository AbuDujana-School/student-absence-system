begin;

insert into public.teachers (name, role, permissions) values
  ('RLS Bridge Test Teacher', 'teacher', '{"attendance":true,"behavior":false,"duty":true}'::jsonb),
  ('RLS Bridge Test Custom', 'custom', '{"attendance":false,"behavior":true,"duty":true}'::jsonb);

insert into public.app_sessions (token_hash, principal_type, principal_name, expires_at)
values
  (encode(extensions.digest(repeat('a', 64), 'sha256'), 'hex'), 'teacher', 'RLS Bridge Test Teacher', now() + interval '1 hour'),
  (encode(extensions.digest(repeat('b', 64), 'sha256'), 'hex'), 'custom', 'RLS Bridge Test Custom', now() + interval '1 hour'),
  (encode(extensions.digest(repeat('c', 64), 'sha256'), 'hex'), 'admin', 'RLS Bridge Test Admin', now() + interval '1 hour');

insert into public.classes (name) values ('TEST/1');
insert into public.students (class_name, student_name) values ('TEST/1', 'Synthetic Student');
insert into public.attendance (record_key,date_str,class_name,period,teacher_name,records)
values ('seed-attendance','2026-11-19','TEST/1',1,'RLS Bridge Test Teacher','{}');
insert into public.behaviors (record_key,date_str,class_name,period,teacher_name,records)
values ('seed-behavior','2026-11-19','TEST/1',1,'RLS Bridge Test Teacher','{}');

-- Valid teacher session: read access is available; attendance writes are allowed;
-- behavior writes and administrative data changes are denied by server-side permissions.
select set_config('request.headers', jsonb_build_object('x-app-session', repeat('a',64))::text, true);
set local role anon;
do $test$
begin
  if (select count(*) from public.classes) <> 1 then
    raise exception 'valid app session could not read classes';
  end if;
  if (select count(*) from public.students) <> 1 then
    raise exception 'valid app session could not read students';
  end if;
  insert into public.attendance(record_key,date_str,class_name,period,teacher_name,records)
  values ('teacher-attendance','2026-11-19','TEST/1',2,'RLS Bridge Test Teacher','{}');
  begin
    insert into public.behaviors(record_key,date_str,class_name,period,teacher_name,records)
    values ('teacher-behavior','2026-11-19','TEST/1',2,'RLS Bridge Test Teacher','{}');
    raise exception 'teacher without behavior permission unexpectedly wrote behavior';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.students(class_name,student_name) values ('TEST/1','Unauthorized Student');
    raise exception 'teacher unexpectedly inserted a student';
  exception when insufficient_privilege then null;
  end;
end;
$test$;
reset role;

-- Custom account: explicit behavior permission is honored; attendance is denied.
select set_config('request.headers', jsonb_build_object('x-app-session', repeat('b',64))::text, true);
set local role anon;
do $test$
begin
  insert into public.behaviors(record_key,date_str,class_name,period,teacher_name,records)
  values ('custom-behavior','2026-11-19','TEST/1',3,'RLS Bridge Test Custom','{}');
  begin
    insert into public.attendance(record_key,date_str,class_name,period,teacher_name,records)
    values ('custom-attendance','2026-11-19','TEST/1',3,'RLS Bridge Test Custom','{}');
    raise exception 'custom account without attendance permission unexpectedly wrote attendance';
  exception when insufficient_privilege then null;
  end;
end;
$test$;
reset role;

-- Administrator: administrative writes are permitted.
select set_config('request.headers', jsonb_build_object('x-app-session', repeat('c',64))::text, true);
set local role anon;
do $test$
begin
  insert into public.classes(name) values ('TEST/2');
  insert into public.students(class_name,student_name) values ('TEST/2','Admin Synthetic Student');
  insert into public.teachers(name,role,permissions) values ('Synthetic Managed Teacher','teacher','{}'::jsonb);
  insert into public.school_settings(key,value) values ('synthetic_setting','{"ok":true}'::jsonb);
  insert into public.duty_reports(id,date_str,class_name,status)
  values ('synthetic-duty','2026-11-19','TEST/1','pending');
end;
$test$;
reset role;

-- No session must not read any school rows or write data.
select set_config('request.headers', '{}'::text, true);
set local role anon;
do $test$
begin
  if exists (select 1 from public.classes) then
    raise exception 'anonymous request read school data without a session';
  end if;
  begin
    insert into public.classes(name) values ('UNAUTHORIZED');
    raise exception 'anonymous request inserted a class without a session';
  exception when insufficient_privilege then null;
  end;
end;
$test$;
reset role;

rollback;
