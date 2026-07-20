ALTER TABLE local_artifacts
  ADD COLUMN checksum text
  CHECK (checksum IS NULL OR checksum ~ '^[a-f0-9]{64}$');

CREATE TABLE browser_profiles (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES local_owners(id) ON DELETE CASCADE,
  name text NOT NULL,
  latest_generation_id uuid,
  writer_session_id uuid,
  retention_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

CREATE TABLE browser_profile_generations (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES browser_profiles(id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation > 0),
  state_path text,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  committed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  file_deleted_at timestamptz,
  UNIQUE (profile_id, generation)
);

CREATE TABLE browser_replay_envelopes (
  scrape_id uuid PRIMARY KEY REFERENCES scrapes(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES local_owners(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version = 1),
  navigation_policy_version integer NOT NULL
    CHECK (navigation_policy_version = 1),
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE browser_replay_checkpoints (
  id uuid PRIMARY KEY,
  scrape_id uuid NOT NULL UNIQUE REFERENCES scrapes(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES local_owners(id) ON DELETE CASCADE,
  envelope_version integer NOT NULL CHECK (envelope_version = 1),
  state_path text,
  final_url text NOT NULL,
  fingerprint jsonb NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  file_deleted_at timestamptz
);

CREATE TABLE browser_sessions (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES local_owners(id) ON DELETE CASCADE,
  scrape_id uuid REFERENCES scrapes(id) ON DELETE CASCADE,
  browser_id text,
  runtime_epoch integer NOT NULL DEFAULT 1 CHECK (runtime_epoch > 0),
  profile_id uuid REFERENCES browser_profiles(id) ON DELETE SET NULL,
  profile_generation_id uuid
    REFERENCES browser_profile_generations(id) ON DELETE SET NULL,
  replay_version integer NOT NULL DEFAULT 1 CHECK (replay_version = 1),
  state text NOT NULL DEFAULT 'creating' CHECK (state IN (
    'creating', 'replaying', 'ready', 'executing', 'stopping',
    'destroyed', 'expired', 'interrupted', 'error'
  )),
  absolute_deadline_at timestamptz NOT NULL,
  idle_deadline_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  current_run_id uuid,
  prompt_used boolean NOT NULL DEFAULT false,
  credits_used integer DEFAULT 0 CHECK (credits_used >= 0),
  prompt_credits_used integer NOT NULL DEFAULT 0
    CHECK (prompt_credits_used >= 0),
  stream_web_view boolean NOT NULL DEFAULT false,
  workspace_id text,
  context_id text,
  cdp_url text,
  cdp_path text,
  cdp_interactive_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  terminal_at timestamptz,
  terminal_reason text,
  team_id text,
  status text NOT NULL DEFAULT 'active',
  ttl_total integer,
  ttl_without_activity integer,
  deleted_at timestamptz
);

CREATE TABLE browser_interact_runs (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES local_owners(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
  scrape_id uuid REFERENCES scrapes(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN (
    'prompt', 'code', 'browser_operation', 'replay'
  )),
  state text NOT NULL CHECK (state IN (
    'queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled',
    'timed_out', 'interrupted'
  )),
  language text,
  model text NOT NULL,
  reasoning_effort text NOT NULL,
  deadline_at timestamptz NOT NULL,
  correlation_id uuid NOT NULL,
  adapter_process_id integer,
  cancelled_at timestamptz,
  output_reference jsonb,
  artifact_references jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(artifact_references) = 'array'),
  error_category text,
  error_detail text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE TABLE browser_interact_actions (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES local_owners(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES browser_interact_runs(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
  adapter_job_id text NOT NULL,
  action_id uuid NOT NULL UNIQUE,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 25),
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[a-f0-9]{64}$'),
  effect text NOT NULL CHECK (effect IN ('read_only', 'side_effecting')),
  operation jsonb NOT NULL,
  state text NOT NULL CHECK (state IN (
    'prepared', 'executing', 'succeeded', 'rejected_no_effect',
    'failed_no_effect', 'cancelled_no_effect', 'outcome_unknown'
  )),
  result jsonb,
  page_state jsonb,
  error_category text,
  error_detail text,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  executing_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence),
  UNIQUE (run_id, action_id),
  UNIQUE (run_id, sequence, proposal_hash)
);

CREATE TABLE browser_session_activities (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES local_owners(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
  run_id uuid REFERENCES browser_interact_runs(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN (
    'prompt', 'code', 'browser_operation', 'replay'
  )),
  language text,
  timeout_ms integer NOT NULL CHECK (timeout_ms > 0),
  exit_code integer,
  killed boolean NOT NULL DEFAULT false,
  kill_reason text,
  source text NOT NULL DEFAULT 'browser',
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  team_id text,
  timeout integer
);

CREATE TABLE browser_capabilities (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  owner_id uuid NOT NULL REFERENCES local_owners(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES browser_interact_runs(id) ON DELETE CASCADE,
  adapter_process_id integer NOT NULL,
  operations jsonb NOT NULL CHECK (jsonb_typeof(operations) = 'array'),
  origins jsonb NOT NULL CHECK (jsonb_typeof(origins) = 'array'),
  navigation_policy_version integer NOT NULL
    CHECK (navigation_policy_version = 1),
  call_limit integer NOT NULL CHECK (call_limit > 0),
  calls_used integer NOT NULL DEFAULT 0
    CHECK (calls_used >= 0 AND calls_used <= call_limit),
  byte_limit bigint NOT NULL CHECK (byte_limit >= 0),
  bytes_used bigint NOT NULL DEFAULT 0
    CHECK (bytes_used >= 0 AND bytes_used <= byte_limit),
  wall_deadline_at timestamptz NOT NULL,
  per_operation_timeout_ms integer NOT NULL
    CHECK (per_operation_timeout_ms > 0),
  issued_at timestamptz NOT NULL DEFAULT now(),
  redeemed_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz NOT NULL
);

CREATE TABLE browser_proxy_grants (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  owner_id uuid NOT NULL REFERENCES local_owners(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission IN (
    'passive', 'interactive', 'cdp'
  )),
  use_limit integer NOT NULL CHECK (use_limit > 0),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= use_limit),
  issued_at timestamptz NOT NULL DEFAULT now(),
  redeemed_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz NOT NULL
);

ALTER TABLE browser_profiles
  ADD CONSTRAINT browser_profiles_latest_generation_fk
  FOREIGN KEY (latest_generation_id)
  REFERENCES browser_profile_generations(id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE browser_profiles
  ADD CONSTRAINT browser_profiles_writer_session_fk
  FOREIGN KEY (writer_session_id)
  REFERENCES browser_sessions(id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE browser_sessions
  ADD CONSTRAINT browser_sessions_current_run_fk
  FOREIGN KEY (current_run_id)
  REFERENCES browser_interact_runs(id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX browser_profiles_writer_session_idx
  ON browser_profiles (writer_session_id)
  WHERE writer_session_id IS NOT NULL;
CREATE INDEX browser_profiles_owner_updated_idx
  ON browser_profiles (owner_id, updated_at DESC);
CREATE INDEX browser_profiles_retention_expires_at_idx
  ON browser_profiles (retention_expires_at)
  WHERE retention_expires_at IS NOT NULL;
CREATE INDEX browser_profile_generations_expires_at_idx
  ON browser_profile_generations (expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX browser_sessions_owner_state_idx
  ON browser_sessions (owner_id, state);
CREATE INDEX browser_sessions_scrape_created_at_idx
  ON browser_sessions (scrape_id, created_at DESC)
  WHERE scrape_id IS NOT NULL;
CREATE INDEX browser_sessions_idle_deadline_at_idx
  ON browser_sessions (idle_deadline_at);
CREATE INDEX browser_sessions_absolute_deadline_at_idx
  ON browser_sessions (absolute_deadline_at);
CREATE INDEX browser_interact_runs_session_state_idx
  ON browser_interact_runs (session_id, state);
CREATE INDEX browser_interact_runs_owner_state_idx
  ON browser_interact_runs (owner_id, state);
CREATE INDEX browser_interact_runs_scrape_queued_at_idx
  ON browser_interact_runs (scrape_id, queued_at DESC)
  WHERE scrape_id IS NOT NULL;
CREATE INDEX browser_interact_runs_deadline_at_idx
  ON browser_interact_runs (deadline_at);
CREATE INDEX browser_interact_actions_run_state_idx
  ON browser_interact_actions (run_id, state);
CREATE INDEX browser_interact_actions_session_state_idx
  ON browser_interact_actions (session_id, state);
CREATE INDEX browser_interact_actions_run_sequence_state_idx
  ON browser_interact_actions (run_id, sequence, state);
CREATE INDEX browser_interact_actions_action_hash_idx
  ON browser_interact_actions (action_id, proposal_hash);
CREATE INDEX browser_replay_checkpoints_expires_at_idx
  ON browser_replay_checkpoints (expires_at);
CREATE INDEX browser_capabilities_token_hash_idx
  ON browser_capabilities (token_hash);
CREATE INDEX browser_capabilities_expires_at_idx
  ON browser_capabilities (expires_at);
CREATE INDEX browser_proxy_grants_token_hash_idx
  ON browser_proxy_grants (token_hash);
CREATE INDEX browser_proxy_grants_expires_at_idx
  ON browser_proxy_grants (expires_at);
CREATE INDEX browser_session_activities_session_created_at_idx
  ON browser_session_activities (session_id, created_at DESC);
