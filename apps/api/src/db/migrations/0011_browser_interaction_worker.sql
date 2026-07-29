DROP TRIGGER IF EXISTS browser_interact_runs_adapter_binding_immutable
  ON browser_interact_runs;
DROP TRIGGER IF EXISTS browser_capabilities_adapter_binding_immutable
  ON browser_capabilities;
DROP FUNCTION IF EXISTS enforce_browser_adapter_binding_immutable();

ALTER TABLE browser_interact_runs
  DROP CONSTRAINT IF EXISTS browser_interact_runs_adapter_process_positive_check,
  DROP CONSTRAINT IF EXISTS browser_interact_runs_adapter_supervisor_non_nil_check,
  DROP CONSTRAINT IF EXISTS browser_interact_runs_adapter_binding_pair_check,
  DROP CONSTRAINT IF EXISTS browser_interact_runs_adapter_process_binding_check,
  DROP CONSTRAINT IF EXISTS browser_interact_runs_adapter_state_binding_check,
  DROP COLUMN IF EXISTS adapter_supervisor_id,
  DROP COLUMN IF EXISTS adapter_process_id;

ALTER TABLE browser_capabilities
  DROP CONSTRAINT IF EXISTS browser_capabilities_adapter_process_positive_check,
  DROP CONSTRAINT IF EXISTS browser_capabilities_adapter_supervisor_non_nil_check,
  DROP CONSTRAINT IF EXISTS browser_capabilities_adapter_binding_pair_check,
  DROP CONSTRAINT IF EXISTS browser_capabilities_activation_pair_check,
  DROP CONSTRAINT IF EXISTS browser_capabilities_active_binding_check,
  DROP CONSTRAINT IF EXISTS browser_capabilities_redeemed_activation_check,
  DROP COLUMN IF EXISTS adapter_supervisor_id,
  DROP COLUMN IF EXISTS adapter_process_id;

ALTER TABLE browser_capabilities
  ADD CONSTRAINT browser_capabilities_active_job_check
  CHECK (revoked_at IS NOT NULL OR adapter_job_id IS NOT NULL);

CREATE FUNCTION enforce_browser_adapter_job_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.adapter_job_id IS NOT NULL
     AND NEW.adapter_job_id IS DISTINCT FROM OLD.adapter_job_id THEN
    RAISE EXCEPTION 'adapter_binding_immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER browser_interact_runs_adapter_job_immutable
BEFORE UPDATE ON browser_interact_runs
FOR EACH ROW
EXECUTE FUNCTION enforce_browser_adapter_job_immutable();

CREATE TRIGGER browser_capabilities_adapter_job_immutable
BEFORE UPDATE ON browser_capabilities
FOR EACH ROW
EXECUTE FUNCTION enforce_browser_adapter_job_immutable();
