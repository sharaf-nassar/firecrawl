CREATE TABLE browser_replay_checkpoint_cleanup_intents (
  id uuid PRIMARY KEY,
  scrape_id uuid NOT NULL REFERENCES scrapes(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES local_owners(id) ON DELETE CASCADE,
  state_path text NOT NULL UNIQUE,
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'cleanup'
    CHECK (state IN ('preparing', 'cleanup')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_category text,
  last_attempted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX browser_replay_checkpoint_cleanup_intents_scrape_id_idx
  ON browser_replay_checkpoint_cleanup_intents (scrape_id);
