ALTER TABLE browser_replay_checkpoint_cleanup_intents
  ADD COLUMN writer_lease uuid,
  ADD COLUMN writer_pid integer,
  ADD COLUMN writer_boot_id text,
  ADD COLUMN writer_start_time text,
  ADD COLUMN heartbeat_at timestamptz;

-- Preparing rows created before writer identities existed cannot prove a live
-- owner. Startup migrations run before request handling, so hand them to the
-- normal cleanup path instead of guessing that an old PID is still valid.
UPDATE browser_replay_checkpoint_cleanup_intents
   SET state = 'cleanup'
 WHERE state = 'preparing';

ALTER TABLE browser_replay_checkpoint_cleanup_intents
  ADD CONSTRAINT browser_replay_checkpoint_cleanup_intents_writer_check
  CHECK (
    state = 'cleanup'
    OR (
      writer_lease IS NOT NULL
      AND writer_pid IS NOT NULL AND writer_pid > 0
      AND writer_boot_id ~ '^[a-f0-9]{32}$'
      AND writer_start_time ~ '^[0-9]+$'
      AND heartbeat_at IS NOT NULL
    )
  );

CREATE UNIQUE INDEX browser_replay_checkpoint_cleanup_intents_writer_lease_idx
  ON browser_replay_checkpoint_cleanup_intents (writer_lease)
  WHERE writer_lease IS NOT NULL;
