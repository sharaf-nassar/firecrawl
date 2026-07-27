ALTER TABLE browser_sessions
  ADD COLUMN stop_attempt_id uuid,
  ADD COLUMN stop_lease_expires_at timestamp with time zone,
  ADD COLUMN stop_owner_instance_id uuid,
  ADD COLUMN stop_owner_generation_nonce text,
  ADD COLUMN billing_subscription_id text,
  ADD COLUMN billing_api_key_id bigint,
  ADD COLUMN billing_endpoint text,
  ADD COLUMN admission_backend text,
  ADD COLUMN keyless_team_id text,
  ADD COLUMN keyless_reserved_credits integer NOT NULL DEFAULT 0;

ALTER TABLE browser_sessions
  ADD CONSTRAINT browser_sessions_billing_endpoint_check
    CHECK (
      billing_endpoint IS NULL
      OR billing_endpoint IN ('browser', 'interact')
    ),
  ADD CONSTRAINT browser_sessions_admission_backend_check
    CHECK (
      admission_backend IS NULL
      OR admission_backend IN ('redis', 'fdb', 'both')
    ),
  ADD CONSTRAINT browser_sessions_stop_lease_check
    CHECK (
      (stop_attempt_id IS NULL)
      = (stop_lease_expires_at IS NULL)
      AND (stop_attempt_id IS NULL)
      = (stop_owner_instance_id IS NULL)
      AND (stop_attempt_id IS NULL)
      = (stop_owner_generation_nonce IS NULL)
    ),
  ADD CONSTRAINT browser_sessions_keyless_reserved_credits_check
    CHECK (
      keyless_reserved_credits >= 0
      AND (
        keyless_reserved_credits = 0
        OR keyless_team_id IS NOT NULL
      )
    );

UPDATE browser_sessions
   SET billing_endpoint = CASE
         WHEN scrape_id IS NULL THEN 'browser'
         ELSE 'interact'
       END,
       admission_backend = CASE
         WHEN state IN (
           'creating', 'replaying', 'ready', 'executing', 'stopping',
           'destroyed', 'expired', 'interrupted', 'error'
         ) THEN 'both'
         ELSE NULL
       END
 WHERE billing_endpoint IS NULL
    OR admission_backend IS NULL;

ALTER TABLE browser_sessions
  ALTER COLUMN billing_endpoint SET DEFAULT 'browser',
  ALTER COLUMN billing_endpoint SET NOT NULL;

CREATE FUNCTION enforce_browser_session_attribution_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.billing_subscription_id IS DISTINCT FROM OLD.billing_subscription_id
     OR NEW.billing_api_key_id IS DISTINCT FROM OLD.billing_api_key_id
     OR NEW.billing_endpoint IS DISTINCT FROM OLD.billing_endpoint
     OR NEW.admission_backend IS DISTINCT FROM OLD.admission_backend
     OR NEW.keyless_team_id IS DISTINCT FROM OLD.keyless_team_id
     OR NEW.keyless_reserved_credits
        IS DISTINCT FROM OLD.keyless_reserved_credits
  THEN
    RAISE EXCEPTION 'browser session attribution is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER browser_sessions_attribution_immutable
BEFORE UPDATE OF
  billing_subscription_id, billing_api_key_id, billing_endpoint,
  admission_backend, keyless_team_id, keyless_reserved_credits
ON browser_sessions
FOR EACH ROW
EXECUTE FUNCTION enforce_browser_session_attribution_immutable();

CREATE TABLE browser_billing_outbox (
  session_id uuid PRIMARY KEY
    REFERENCES browser_sessions(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  subscription_id text,
  api_key_id bigint,
  endpoint text NOT NULL
    CHECK (endpoint IN ('browser', 'interact')),
  session_duration_ms integer NOT NULL CHECK (session_duration_ms >= 0),
  credits integer NOT NULL CHECK (credits >= 0),
  used_prompt boolean NOT NULL,
  keyless_team_id text,
  keyless_reserved_credits integer NOT NULL DEFAULT 0
    CHECK (keyless_reserved_credits >= 0),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'delivered')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token uuid,
  lease_expires_at timestamp with time zone,
  next_attempt_at timestamp with time zone NOT NULL DEFAULT now(),
  last_error_category text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  delivered_at timestamp with time zone,
  CONSTRAINT browser_billing_outbox_lease_check CHECK (
    (lease_token IS NULL) = (lease_expires_at IS NULL)
  ),
  CONSTRAINT browser_billing_outbox_delivery_check CHECK (
    (state = 'delivered') = (delivered_at IS NOT NULL)
  )
);

CREATE INDEX browser_billing_outbox_due_idx
  ON browser_billing_outbox (state, next_attempt_at);

CREATE TABLE browser_billing_sink_receipts (
  session_id uuid PRIMARY KEY
    REFERENCES browser_sessions(id) ON DELETE CASCADE,
  legacy_acked_at timestamp with time zone,
  autumn_acked_at timestamp with time zone,
  keyless_adjustment_acked_at timestamp with time zone,
  keyless_logging_acked_at timestamp with time zone,
  keyless_receipt_gc_acked_at timestamp with time zone,
  keyless_acked_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE browser_keyless_usage_log (
  session_id uuid PRIMARY KEY
    REFERENCES browser_sessions(id) ON DELETE CASCADE,
  keyless_team_id text NOT NULL,
  credits integer NOT NULL CHECK (credits >= 0),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE browser_admission_cleanup (
  session_id uuid PRIMARY KEY
    REFERENCES browser_sessions(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  backend text NOT NULL CHECK (backend IN ('redis', 'fdb', 'both')),
  redis_released_at timestamp with time zone,
  fdb_released_at timestamp with time zone,
  lease_token uuid,
  lease_expires_at timestamp with time zone,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamp with time zone NOT NULL DEFAULT now(),
  last_error_category text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT browser_admission_cleanup_lease_check CHECK (
    (lease_token IS NULL) = (lease_expires_at IS NULL)
  )
);

CREATE INDEX browser_admission_cleanup_due_idx
  ON browser_admission_cleanup (next_attempt_at);

INSERT INTO browser_billing_outbox (
  session_id, owner_id, subscription_id, api_key_id, endpoint,
  session_duration_ms, credits, used_prompt, keyless_team_id,
  keyless_reserved_credits, state, delivered_at
)
SELECT id, owner_id, billing_subscription_id, billing_api_key_id,
       billing_endpoint,
       greatest(
         0,
         floor(
           extract(epoch FROM (coalesce(terminal_at, updated_at) - created_at))
           * 1000
         )::integer
       ),
       coalesce(credits_used, 0),
       prompt_used,
       keyless_team_id,
       keyless_reserved_credits,
       'delivered',
       now()
  FROM browser_sessions
 WHERE state IN ('destroyed', 'expired', 'interrupted', 'error')
ON CONFLICT (session_id) DO NOTHING;

INSERT INTO browser_billing_sink_receipts (
  session_id, legacy_acked_at, autumn_acked_at,
  keyless_adjustment_acked_at, keyless_logging_acked_at,
  keyless_receipt_gc_acked_at, keyless_acked_at
)
SELECT id, now(), now(), now(), now(), now(), now()
  FROM browser_sessions
 WHERE state IN ('destroyed', 'expired', 'interrupted', 'error')
ON CONFLICT (session_id) DO NOTHING;

INSERT INTO browser_admission_cleanup (
  session_id, owner_id, backend, redis_released_at, fdb_released_at
)
SELECT id, owner_id, coalesce(admission_backend, 'both'),
       CASE
         WHEN state IN ('destroyed', 'expired', 'interrupted', 'error')
           THEN now()
       END,
       CASE
         WHEN state IN ('destroyed', 'expired', 'interrupted', 'error')
           THEN now()
       END
  FROM browser_sessions
 WHERE state IN (
   'creating', 'replaying', 'ready', 'executing', 'stopping',
   'destroyed', 'expired', 'interrupted', 'error'
 )
ON CONFLICT (session_id) DO NOTHING;
