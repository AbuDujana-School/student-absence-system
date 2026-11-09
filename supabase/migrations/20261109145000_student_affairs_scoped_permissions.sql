alter table public.student_affairs_permissions
  add column if not exists allowed_attendance_classes text[],
  add column if not exists allowed_behavior_classes text[],
  add column if not exists attendance_statuses text[] not null default array['absent','late','escape','outside']::text[];

comment on column public.student_affairs_permissions.allowed_attendance_classes is
  'Student Affairs classes permitted for attendance monitoring; null falls back to legacy allowed_classes.';
comment on column public.student_affairs_permissions.allowed_behavior_classes is
  'Student Affairs classes permitted for behavior monitoring; null falls back to legacy allowed_classes.';
comment on column public.student_affairs_permissions.attendance_statuses is
  'Attendance status keys visible to this principal; present is intentionally excluded.';
