ALTER TABLE scrapes
  ADD CONSTRAINT scrapes_request_id_requests_fk
  FOREIGN KEY (request_id) REFERENCES requests(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE parses
  ADD CONSTRAINT parses_request_id_requests_fk
  FOREIGN KEY (request_id) REFERENCES requests(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE crawls
  ADD CONSTRAINT crawls_request_id_requests_fk
  FOREIGN KEY (request_id) REFERENCES requests(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE batch_scrapes
  ADD CONSTRAINT batch_scrapes_request_id_requests_fk
  FOREIGN KEY (request_id) REFERENCES requests(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE searches
  ADD CONSTRAINT searches_request_id_requests_fk
  FOREIGN KEY (request_id) REFERENCES requests(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE extracts
  ADD CONSTRAINT extracts_request_id_requests_fk
  FOREIGN KEY (request_id) REFERENCES requests(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE maps
  ADD CONSTRAINT maps_request_id_requests_fk
  FOREIGN KEY (request_id) REFERENCES requests(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE llmstxts
  ADD CONSTRAINT llmstxts_request_id_requests_fk
  FOREIGN KEY (request_id) REFERENCES requests(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE deep_researches
  ADD CONSTRAINT deep_researches_request_id_requests_fk
  FOREIGN KEY (request_id) REFERENCES requests(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE research_paper_searches
  ADD CONSTRAINT research_paper_searches_request_id_requests_fk
  FOREIGN KEY (request_id) REFERENCES requests(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE research_paper_inspects
  ADD CONSTRAINT research_paper_inspects_request_id_requests_fk
  FOREIGN KEY (request_id) REFERENCES requests(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE research_paper_reads
  ADD CONSTRAINT research_paper_reads_request_id_requests_fk
  FOREIGN KEY (request_id) REFERENCES requests(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE research_related_papers
  ADD CONSTRAINT research_related_papers_request_id_requests_fk
  FOREIGN KEY (request_id) REFERENCES requests(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE research_github_searches
  ADD CONSTRAINT research_github_searches_request_id_requests_fk
  FOREIGN KEY (request_id) REFERENCES requests(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE webhook_logs
  ADD COLUMN request_id uuid,
  ADD COLUMN dr_clean_by timestamptz;

CREATE FUNCTION retention_resolve_webhook_request_id(
  lookup_job_id uuid,
  lookup_scrape_id uuid
) RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT candidate.request_id
    FROM (
      SELECT request_id, 1 AS priority
        FROM crawls WHERE id = lookup_job_id
      UNION ALL
      SELECT request_id, 2
        FROM batch_scrapes WHERE id = lookup_job_id
      UNION ALL
      SELECT request_id, 3
        FROM extracts WHERE id = lookup_job_id
      UNION ALL
      SELECT request_id, 4
        FROM scrapes WHERE id = lookup_job_id
      UNION ALL
      SELECT request_id, 5
        FROM scrapes
       WHERE id = lookup_scrape_id
    ) AS candidate
   ORDER BY candidate.priority
   LIMIT 1
$$;

UPDATE webhook_logs
   SET request_id = retention_resolve_webhook_request_id(crawl_id, scrape_id);

UPDATE webhook_logs AS webhook
   SET dr_clean_by = request.dr_clean_by
  FROM requests AS request
 WHERE request.id = webhook.request_id
   AND request.dr_clean_by IS NOT NULL;

UPDATE webhook_logs
   SET dr_clean_by = LEAST(
     created_at + interval '24 hours',
     now() + interval '24 hours'
   )
 WHERE dr_clean_by IS NULL;

DELETE FROM webhook_logs WHERE dr_clean_by <= now();

ALTER TABLE webhook_logs
  ALTER COLUMN dr_clean_by SET NOT NULL,
  ADD CONSTRAINT webhook_logs_request_id_requests_fk
  FOREIGN KEY (request_id) REFERENCES requests(id)
  ON DELETE SET NULL NOT VALID;

CREATE FUNCTION retention_assign_webhook_deadline()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.request_id IS NOT NULL
     AND NEW.request_id IS NULL
     AND NEW.crawl_id IS NOT DISTINCT FROM OLD.crawl_id
     AND NEW.scrape_id IS NOT DISTINCT FROM OLD.scrape_id
     AND NEW.dr_clean_by IS NOT DISTINCT FROM OLD.dr_clean_by THEN
    RETURN NEW;
  END IF;
  IF NEW.request_id IS NULL THEN
    NEW.request_id := retention_resolve_webhook_request_id(
      NEW.crawl_id,
      NEW.scrape_id
    );
  END IF;
  IF NEW.request_id IS NOT NULL THEN
    SELECT request.dr_clean_by
      INTO NEW.dr_clean_by
      FROM requests AS request
     WHERE request.id = NEW.request_id;
  END IF;
  IF NEW.request_id IS NULL OR NEW.dr_clean_by IS NULL THEN
    NEW.dr_clean_by := LEAST(
      COALESCE(NEW.dr_clean_by, 'infinity'::timestamptz),
      COALESCE(NEW.created_at, now()) + interval '24 hours',
      now() + interval '24 hours'
    );
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER retention_assign_webhook_deadline
BEFORE INSERT OR UPDATE OF crawl_id, scrape_id, request_id, dr_clean_by
ON webhook_logs
FOR EACH ROW
EXECUTE FUNCTION retention_assign_webhook_deadline();

DELETE FROM scrapes AS child
 WHERE NOT EXISTS (
   SELECT 1 FROM requests AS parent WHERE parent.id = child.request_id
 );
DELETE FROM parses AS child
 WHERE NOT EXISTS (
   SELECT 1 FROM requests AS parent WHERE parent.id = child.request_id
 );
DELETE FROM crawls AS child
 WHERE NOT EXISTS (
   SELECT 1 FROM requests AS parent WHERE parent.id = child.request_id
 );
DELETE FROM batch_scrapes AS child
 WHERE NOT EXISTS (
   SELECT 1 FROM requests AS parent WHERE parent.id = child.request_id
 );
DELETE FROM searches AS child
 WHERE NOT EXISTS (
   SELECT 1 FROM requests AS parent WHERE parent.id = child.request_id
 );
DELETE FROM extracts AS child
 WHERE NOT EXISTS (
   SELECT 1 FROM requests AS parent WHERE parent.id = child.request_id
 );
DELETE FROM maps AS child
 WHERE NOT EXISTS (
   SELECT 1 FROM requests AS parent WHERE parent.id = child.request_id
 );
DELETE FROM llmstxts AS child
 WHERE NOT EXISTS (
   SELECT 1 FROM requests AS parent WHERE parent.id = child.request_id
 );
DELETE FROM deep_researches AS child
 WHERE NOT EXISTS (
   SELECT 1 FROM requests AS parent WHERE parent.id = child.request_id
 );
DELETE FROM research_paper_searches AS child
 WHERE NOT EXISTS (
   SELECT 1 FROM requests AS parent WHERE parent.id = child.request_id
 );
DELETE FROM research_paper_inspects AS child
 WHERE NOT EXISTS (
   SELECT 1 FROM requests AS parent WHERE parent.id = child.request_id
 );
DELETE FROM research_paper_reads AS child
 WHERE NOT EXISTS (
   SELECT 1 FROM requests AS parent WHERE parent.id = child.request_id
 );
DELETE FROM research_related_papers AS child
 WHERE NOT EXISTS (
   SELECT 1 FROM requests AS parent WHERE parent.id = child.request_id
 );
DELETE FROM research_github_searches AS child
 WHERE NOT EXISTS (
   SELECT 1 FROM requests AS parent WHERE parent.id = child.request_id
 );

ALTER TABLE scrapes VALIDATE CONSTRAINT scrapes_request_id_requests_fk;
ALTER TABLE parses VALIDATE CONSTRAINT parses_request_id_requests_fk;
ALTER TABLE crawls VALIDATE CONSTRAINT crawls_request_id_requests_fk;
ALTER TABLE batch_scrapes
  VALIDATE CONSTRAINT batch_scrapes_request_id_requests_fk;
ALTER TABLE searches VALIDATE CONSTRAINT searches_request_id_requests_fk;
ALTER TABLE extracts VALIDATE CONSTRAINT extracts_request_id_requests_fk;
ALTER TABLE maps VALIDATE CONSTRAINT maps_request_id_requests_fk;
ALTER TABLE llmstxts VALIDATE CONSTRAINT llmstxts_request_id_requests_fk;
ALTER TABLE deep_researches
  VALIDATE CONSTRAINT deep_researches_request_id_requests_fk;
ALTER TABLE research_paper_searches
  VALIDATE CONSTRAINT research_paper_searches_request_id_requests_fk;
ALTER TABLE research_paper_inspects
  VALIDATE CONSTRAINT research_paper_inspects_request_id_requests_fk;
ALTER TABLE research_paper_reads
  VALIDATE CONSTRAINT research_paper_reads_request_id_requests_fk;
ALTER TABLE research_related_papers
  VALIDATE CONSTRAINT research_related_papers_request_id_requests_fk;
ALTER TABLE research_github_searches
  VALIDATE CONSTRAINT research_github_searches_request_id_requests_fk;
ALTER TABLE webhook_logs
  VALIDATE CONSTRAINT webhook_logs_request_id_requests_fk;

CREATE INDEX webhook_logs_dr_clean_by_idx
  ON webhook_logs (dr_clean_by);
