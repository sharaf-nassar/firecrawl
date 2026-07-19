CREATE TABLE local_owners (
  id uuid PRIMARY KEY,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE local_artifacts (
  object_key text PRIMARY KEY,
  owner_id uuid NOT NULL,
  request_id uuid,
  job_id uuid,
  kind text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delete_after timestamptz
);

CREATE TABLE requests (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  api_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  team_id uuid NOT NULL,
  origin text NOT NULL,
  integration text,
  target_hint text NOT NULL,
  dr_clean_by timestamptz,
  api_key_id bigint
);

CREATE TABLE scrapes (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  url text NOT NULL,
  is_successful boolean NOT NULL,
  error text,
  time_taken numeric NOT NULL,
  team_id uuid NOT NULL,
  options jsonb,
  cost_tracking jsonb,
  pdf_num_pages integer,
  credits_cost integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  monitor_id uuid,
  monitor_check_id uuid,
  content_type text
);

CREATE TABLE parses (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  url text NOT NULL,
  is_successful boolean NOT NULL,
  error text,
  time_taken numeric NOT NULL,
  team_id uuid NOT NULL,
  options jsonb,
  cost_tracking jsonb,
  pdf_num_pages integer,
  credits_cost integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crawls (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  url text NOT NULL,
  team_id uuid NOT NULL,
  options jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  num_docs integer NOT NULL,
  credits_cost integer NOT NULL,
  cancelled boolean NOT NULL,
  monitor_id uuid,
  monitor_check_id uuid
);

CREATE TABLE batch_scrapes (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  team_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  num_docs integer NOT NULL,
  credits_cost integer NOT NULL,
  cancelled boolean NOT NULL
);

CREATE TABLE searches (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  query text NOT NULL,
  team_id uuid NOT NULL,
  options jsonb,
  time_taken numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  credits_cost integer NOT NULL,
  is_successful boolean NOT NULL,
  error text,
  num_results integer NOT NULL
);

CREATE TABLE extracts (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  urls text[] NOT NULL,
  options jsonb,
  model_kind text NOT NULL,
  team_id uuid NOT NULL,
  is_successful boolean NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  credits_cost integer NOT NULL,
  cost_tracking jsonb
);

CREATE TABLE maps (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  url text NOT NULL,
  options jsonb,
  team_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  num_results integer NOT NULL,
  credits_cost integer NOT NULL
);

CREATE TABLE llmstxts (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  url text NOT NULL,
  team_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  num_urls integer NOT NULL,
  options jsonb,
  cost_tracking jsonb,
  credits_cost integer NOT NULL
);

CREATE TABLE deep_researches (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  query text NOT NULL,
  team_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  time_taken numeric NOT NULL,
  credits_cost integer NOT NULL,
  cost_tracking jsonb,
  options jsonb
);

CREATE TABLE research_paper_searches (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  target text NOT NULL,
  team_id uuid NOT NULL,
  options jsonb,
  response jsonb,
  num_results integer NOT NULL,
  time_taken numeric NOT NULL,
  credits_cost integer NOT NULL,
  is_successful boolean NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE research_paper_inspects (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  target text NOT NULL,
  team_id uuid NOT NULL,
  options jsonb,
  response jsonb,
  num_results integer NOT NULL,
  time_taken numeric NOT NULL,
  credits_cost integer NOT NULL,
  is_successful boolean NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE research_paper_reads (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  target text NOT NULL,
  team_id uuid NOT NULL,
  options jsonb,
  response jsonb,
  num_results integer NOT NULL,
  time_taken numeric NOT NULL,
  credits_cost integer NOT NULL,
  is_successful boolean NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE research_related_papers (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  target text NOT NULL,
  team_id uuid NOT NULL,
  options jsonb,
  response jsonb,
  num_results integer NOT NULL,
  time_taken numeric NOT NULL,
  credits_cost integer NOT NULL,
  is_successful boolean NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE research_github_searches (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  target text NOT NULL,
  team_id uuid NOT NULL,
  options jsonb,
  response jsonb,
  num_results integer NOT NULL,
  time_taken numeric NOT NULL,
  credits_cost integer NOT NULL,
  is_successful boolean NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  key uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deterministic_json_scripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key text NOT NULL UNIQUE,
  code text NOT NULL,
  url text,
  model text,
  cache_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deterministic_json_llm_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key text NOT NULL UNIQUE,
  response text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  success boolean NOT NULL,
  error text,
  team_id uuid NOT NULL,
  crawl_id uuid NOT NULL,
  scrape_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  url text NOT NULL,
  status_code smallint,
  event text NOT NULL,
  latency_ms integer DEFAULT 0
);

CREATE INDEX requests_team_created_at_idx
  ON requests (team_id, created_at DESC);
CREATE INDEX requests_dr_clean_by_idx
  ON requests (dr_clean_by)
  WHERE dr_clean_by IS NOT NULL;
CREATE INDEX local_artifacts_delete_after_idx
  ON local_artifacts (delete_after)
  WHERE delete_after IS NOT NULL;
CREATE INDEX local_artifacts_owner_created_at_idx
  ON local_artifacts (owner_id, created_at DESC);

CREATE INDEX scrapes_request_id_idx ON scrapes (request_id);
CREATE INDEX scrapes_team_created_at_idx
  ON scrapes (team_id, created_at DESC);
CREATE INDEX parses_request_id_idx ON parses (request_id);
CREATE INDEX parses_team_created_at_idx
  ON parses (team_id, created_at DESC);
CREATE INDEX crawls_request_id_idx ON crawls (request_id);
CREATE INDEX crawls_team_created_at_idx
  ON crawls (team_id, created_at DESC);
CREATE INDEX batch_scrapes_request_id_idx ON batch_scrapes (request_id);
CREATE INDEX batch_scrapes_team_created_at_idx
  ON batch_scrapes (team_id, created_at DESC);
CREATE INDEX searches_request_id_idx ON searches (request_id);
CREATE INDEX searches_team_created_at_idx
  ON searches (team_id, created_at DESC);
CREATE INDEX extracts_request_id_idx ON extracts (request_id);
CREATE INDEX extracts_team_created_at_idx
  ON extracts (team_id, created_at DESC);
CREATE INDEX maps_request_id_idx ON maps (request_id);
CREATE INDEX maps_team_created_at_idx
  ON maps (team_id, created_at DESC);
CREATE INDEX llmstxts_request_id_idx ON llmstxts (request_id);
CREATE INDEX llmstxts_team_created_at_idx
  ON llmstxts (team_id, created_at DESC);
CREATE INDEX deep_researches_request_id_idx
  ON deep_researches (request_id);
CREATE INDEX deep_researches_team_created_at_idx
  ON deep_researches (team_id, created_at DESC);
CREATE INDEX research_paper_searches_request_id_idx
  ON research_paper_searches (request_id);
CREATE INDEX research_paper_searches_team_created_at_idx
  ON research_paper_searches (team_id, created_at DESC);
CREATE INDEX research_paper_inspects_request_id_idx
  ON research_paper_inspects (request_id);
CREATE INDEX research_paper_inspects_team_created_at_idx
  ON research_paper_inspects (team_id, created_at DESC);
CREATE INDEX research_paper_reads_request_id_idx
  ON research_paper_reads (request_id);
CREATE INDEX research_paper_reads_team_created_at_idx
  ON research_paper_reads (team_id, created_at DESC);
CREATE INDEX research_related_papers_request_id_idx
  ON research_related_papers (request_id);
CREATE INDEX research_related_papers_team_created_at_idx
  ON research_related_papers (team_id, created_at DESC);
CREATE INDEX research_github_searches_request_id_idx
  ON research_github_searches (request_id);
CREATE INDEX research_github_searches_team_created_at_idx
  ON research_github_searches (team_id, created_at DESC);
