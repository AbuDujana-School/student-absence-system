-- Temporary privilege expansion recorded in remote migration history.
-- The follow-up migration restores the audited-cancellation model.
GRANT DELETE ON TABLE public.morning_assembly_lateness TO service_role;
