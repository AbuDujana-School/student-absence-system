create table if not exists public.morning_assembly_lateness (
  id uuid primary key default gen_random_uuid(),
  student_id bigint not null,
  student_name_snapshot text not null,
  class_name_snapshot text not null,
  late_date date not null,
  recorded_at timestamptz not null default now(),
  recorder_type text not null check (recorder_type in ('admin','teacher','custom')),
  recorder_name text not null,
  academic_year text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists morning_assembly_lateness_student_day_uidx
  on public.morning_assembly_lateness (student_id, late_date);
create index if not exists morning_assembly_lateness_year_student_date_idx
  on public.morning_assembly_lateness (academic_year, student_id, late_date desc);
create index if not exists morning_assembly_lateness_date_idx
  on public.morning_assembly_lateness (late_date desc);
alter table public.morning_assembly_lateness enable row level security;
comment on table public.morning_assembly_lateness is
  'Independent morning assembly lateness ledger. Does not write to attendance or behavior records.';