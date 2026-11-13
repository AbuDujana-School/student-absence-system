-- Supporting indexes for timetable foreign-key lookups and delete checks.
-- Additive only: no existing records or permissions are changed.

create index if not exists timetable_assignment_audit_assignment_id_idx
  on public.timetable_assignment_audit (assignment_id);

create index if not exists timetable_import_audit_record_id_idx
  on public.timetable_import_audit (record_id);

create index if not exists timetable_import_records_import_teacher_id_idx
  on public.timetable_import_records (import_teacher_id);

create index if not exists timetable_imports_parent_import_id_idx
  on public.timetable_imports (parent_import_id);
