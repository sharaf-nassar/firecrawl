CREATE UNIQUE INDEX browser_sessions_active_scrape_idx
  ON browser_sessions (scrape_id)
  WHERE scrape_id IS NOT NULL
    AND state IN ('creating', 'replaying', 'ready', 'executing', 'stopping');
