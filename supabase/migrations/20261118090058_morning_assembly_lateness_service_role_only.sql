revoke all privileges on table public.morning_assembly_lateness from anon, authenticated;
grant select, insert on table public.morning_assembly_lateness to service_role;
alter table public.morning_assembly_lateness enable row level security;
