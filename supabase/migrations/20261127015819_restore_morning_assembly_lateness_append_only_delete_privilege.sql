-- Restore the audited-cancellation design: lateness events are never physically deleted.
-- The Edge Function updates only cancellation metadata columns.
REVOKE DELETE ON TABLE public.morning_assembly_lateness FROM service_role;
