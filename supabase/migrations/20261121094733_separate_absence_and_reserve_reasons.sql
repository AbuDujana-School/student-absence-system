-- Separate the absent teacher's reason from the substitute duty reason.
-- The database column is deliberately independent from reserve_reason.
alter table public.timetable_assignments
  add column if not exists absence_reason text not null default '-';

update public.timetable_assignments
set absence_reason = '-'
where absence_reason is null or btrim(absence_reason) = '';

alter table public.timetable_assignments
  alter column absence_reason set default '-',
  alter column absence_reason set not null;

comment on column public.timetable_assignments.absence_reason is
  'Reason for the absent teacher not attending; separate from reserve_reason which describes the substitute duty.';
