-- Minimal, synthetic table fixtures for the app-session RLS integration suite.
create table public.classes (name text primary key);
create table public.students (
  id bigserial primary key,
  class_name text not null,
  student_name text not null,
  unique (class_name, student_name)
);
create table public.teachers (
  id bigserial primary key,
  name text not null unique,
  role text not null,
  permissions jsonb not null default '{}'::jsonb,
  pin_hash text,
  pin_salt text,
  must_change_pin boolean not null default false
);
create table public.attendance (
  id bigserial primary key,
  record_key text not null unique,
  date_str date not null,
  class_name text not null,
  period integer not null,
  teacher_name text not null,
  records jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table public.behaviors (
  id bigserial primary key,
  record_key text not null unique,
  date_str date not null,
  class_name text not null,
  period integer not null,
  teacher_name text not null,
  records jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table public.school_settings (key text primary key, value jsonb);
create table public.duty_reports (
  id text primary key,
  date_str text not null,
  day_num text,
  period integer,
  class_name text not null,
  subject text,
  teacher_name text,
  reported_by text,
  status text not null default 'pending',
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
