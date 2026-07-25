DO $$
BEGIN
  IF EXISTS (
    SELECT 1
     FROM browser_interact_actions
     WHERE adapter_job_id !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR adapter_job_id = '00000000-0000-0000-0000-000000000000'
  ) THEN
    RAISE EXCEPTION 'browser_adapter_job_id_preflight_failed';
  END IF;
END $$;

ALTER TABLE browser_interact_actions
  ALTER COLUMN adapter_job_id TYPE uuid USING adapter_job_id::uuid;

ALTER TABLE browser_interact_actions
  ADD CONSTRAINT browser_interact_actions_adapter_job_non_nil_check
    CHECK (
      adapter_job_id <> '00000000-0000-0000-0000-000000000000'::uuid
    );

ALTER TABLE browser_capabilities
  ALTER COLUMN adapter_process_id DROP NOT NULL;

UPDATE browser_interact_runs
   SET state = 'interrupted',
       finished_at = COALESCE(finished_at, now()),
       error_category = COALESCE(
         error_category,
         'adapter_binding_migration'
       ),
       adapter_process_id = NULL
 WHERE state IN ('starting', 'running');

UPDATE browser_interact_runs
   SET adapter_process_id = NULL
 WHERE adapter_process_id IS NOT NULL;

UPDATE browser_capabilities
   SET revoked_at = COALESCE(revoked_at, now()),
       adapter_process_id = NULL;

ALTER TABLE browser_interact_runs
  ADD COLUMN adapter_job_id uuid,
  ADD COLUMN adapter_supervisor_id uuid;

ALTER TABLE browser_capabilities
  ADD COLUMN adapter_job_id uuid,
  ADD COLUMN adapter_supervisor_id uuid,
  ADD COLUMN activated_at timestamptz;

ALTER TABLE browser_interact_runs
  ADD CONSTRAINT browser_interact_runs_adapter_job_non_nil_check
    CHECK (
      adapter_job_id IS NULL
      OR adapter_job_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  ADD CONSTRAINT browser_interact_runs_adapter_supervisor_non_nil_check
    CHECK (
      adapter_supervisor_id IS NULL
      OR adapter_supervisor_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  ADD CONSTRAINT browser_interact_runs_adapter_process_positive_check
    CHECK (
      adapter_process_id IS NULL OR adapter_process_id > 0
    ),
  ADD CONSTRAINT browser_interact_runs_adapter_binding_pair_check
    CHECK (
      (adapter_job_id IS NULL) = (adapter_supervisor_id IS NULL)
    ),
  ADD CONSTRAINT browser_interact_runs_adapter_process_binding_check
    CHECK (
      adapter_process_id IS NULL OR adapter_job_id IS NOT NULL
    ),
  ADD CONSTRAINT browser_interact_runs_adapter_state_binding_check
    CHECK (
      (
        mode IN ('browser_operation', 'replay')
        AND adapter_job_id IS NULL
        AND adapter_supervisor_id IS NULL
        AND adapter_process_id IS NULL
      )
      OR
      (
        mode IN ('prompt', 'code')
        AND (
          (
            state = 'queued'
            AND adapter_job_id IS NULL
            AND adapter_supervisor_id IS NULL
            AND adapter_process_id IS NULL
          )
          OR
          (
            state = 'starting'
            AND adapter_job_id IS NOT NULL
            AND adapter_supervisor_id IS NOT NULL
            AND adapter_process_id IS NULL
          )
          OR
          (
            state = 'running'
            AND adapter_job_id IS NOT NULL
            AND adapter_supervisor_id IS NOT NULL
            AND adapter_process_id IS NOT NULL
          )
          OR
          (
            state IN (
              'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'
            )
            AND (
              (
                adapter_job_id IS NULL
                AND adapter_supervisor_id IS NULL
                AND adapter_process_id IS NULL
              )
              OR
              (
                adapter_job_id IS NOT NULL
                AND adapter_supervisor_id IS NOT NULL
              )
            )
          )
        )
      )
    );

ALTER TABLE browser_capabilities
  ADD CONSTRAINT browser_capabilities_adapter_job_non_nil_check
    CHECK (
      adapter_job_id IS NULL
      OR adapter_job_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  ADD CONSTRAINT browser_capabilities_adapter_supervisor_non_nil_check
    CHECK (
      adapter_supervisor_id IS NULL
      OR adapter_supervisor_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  ADD CONSTRAINT browser_capabilities_adapter_process_positive_check
    CHECK (
      adapter_process_id IS NULL OR adapter_process_id > 0
    ),
  ADD CONSTRAINT browser_capabilities_adapter_binding_pair_check
    CHECK (
      (adapter_job_id IS NULL) = (adapter_supervisor_id IS NULL)
    ),
  ADD CONSTRAINT browser_capabilities_activation_pair_check
    CHECK (
      (adapter_process_id IS NULL) = (activated_at IS NULL)
    ),
  ADD CONSTRAINT browser_capabilities_active_binding_check
    CHECK (
      revoked_at IS NOT NULL
      OR (
        adapter_job_id IS NOT NULL
        AND adapter_supervisor_id IS NOT NULL
      )
    ),
  ADD CONSTRAINT browser_capabilities_redeemed_activation_check
    CHECK (
      redeemed_at IS NULL
      OR (
        adapter_process_id IS NOT NULL
        AND activated_at IS NOT NULL
      )
    );

CREATE UNIQUE INDEX browser_interact_runs_adapter_job_id_key
  ON browser_interact_runs (adapter_job_id)
  WHERE adapter_job_id IS NOT NULL;

CREATE UNIQUE INDEX browser_capabilities_active_run_job_key
  ON browser_capabilities (run_id, adapter_job_id)
  WHERE revoked_at IS NULL;

CREATE FUNCTION enforce_browser_adapter_binding_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.adapter_job_id IS NOT NULL
     AND NEW.adapter_job_id IS DISTINCT FROM OLD.adapter_job_id THEN
    RAISE EXCEPTION 'adapter_binding_immutable';
  END IF;
  IF OLD.adapter_supervisor_id IS NOT NULL
     AND NEW.adapter_supervisor_id IS DISTINCT FROM OLD.adapter_supervisor_id
  THEN
    RAISE EXCEPTION 'adapter_binding_immutable';
  END IF;

  IF TG_TABLE_NAME = 'browser_interact_runs' THEN
    IF OLD.adapter_process_id IS NOT NULL
       AND NEW.adapter_process_id IS DISTINCT FROM OLD.adapter_process_id THEN
      RAISE EXCEPTION 'adapter_binding_immutable';
    END IF;
  ELSE
    IF (
      OLD.adapter_process_id IS NOT NULL
      OR OLD.activated_at IS NOT NULL
    ) AND (
      NEW.adapter_process_id IS DISTINCT FROM OLD.adapter_process_id
      OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
    ) THEN
      RAISE EXCEPTION 'adapter_binding_immutable';
    END IF;
    IF OLD.adapter_process_id IS NULL
       AND OLD.activated_at IS NULL
       AND (
         (NEW.adapter_process_id IS NULL) <>
         (NEW.activated_at IS NULL)
       ) THEN
      RAISE EXCEPTION 'adapter_binding_immutable';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER browser_interact_runs_adapter_binding_immutable
BEFORE UPDATE ON browser_interact_runs
FOR EACH ROW
EXECUTE FUNCTION enforce_browser_adapter_binding_immutable();

CREATE TRIGGER browser_capabilities_adapter_binding_immutable
BEFORE UPDATE ON browser_capabilities
FOR EACH ROW
EXECUTE FUNCTION enforce_browser_adapter_binding_immutable();
