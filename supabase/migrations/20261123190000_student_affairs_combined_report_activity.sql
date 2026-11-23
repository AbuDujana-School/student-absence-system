-- Add an explicit audit event for the Student Affairs combined (absence + behavior) report.
alter table public.student_affairs_activity_events
  drop constraint if exists student_affairs_activity_events_event_type_check;

alter table public.student_affairs_activity_events
  add constraint student_affairs_activity_events_event_type_check
  check (event_type in (
    'module_access',
    'absence_report_view',
    'behavior_report_view',
    'combined_report_view',
    'formal_warning_issued',
    'formal_warning_print'
  ));

comment on column public.student_affairs_activity_events.event_type is
  'Student Affairs activity event; combined_report_view means the teacher viewed absence and behavior together.';
