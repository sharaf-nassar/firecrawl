WITH legacy_children AS (
  SELECT request_id, team_id, created_at FROM scrapes
  UNION ALL
  SELECT request_id, team_id, created_at FROM parses
  UNION ALL
  SELECT request_id, team_id, created_at FROM crawls
  UNION ALL
  SELECT request_id, team_id, created_at FROM batch_scrapes
  UNION ALL
  SELECT request_id, team_id, created_at FROM searches
  UNION ALL
  SELECT request_id, team_id, created_at FROM extracts
  UNION ALL
  SELECT request_id, team_id, created_at FROM maps
  UNION ALL
  SELECT request_id, team_id, created_at FROM llmstxts
  UNION ALL
  SELECT request_id, team_id, created_at FROM deep_researches
  UNION ALL
  SELECT request_id, team_id, created_at FROM research_paper_searches
  UNION ALL
  SELECT request_id, team_id, created_at FROM research_paper_inspects
  UNION ALL
  SELECT request_id, team_id, created_at FROM research_paper_reads
  UNION ALL
  SELECT request_id, team_id, created_at FROM research_related_papers
  UNION ALL
  SELECT request_id, team_id, created_at FROM research_github_searches
), missing_requests AS (
  SELECT DISTINCT ON (child.request_id)
         child.request_id,
         child.team_id,
         child.created_at
    FROM legacy_children AS child
    LEFT JOIN requests AS request ON request.id = child.request_id
   WHERE request.id IS NULL
   ORDER BY child.request_id, child.created_at, child.team_id
)
INSERT INTO requests (
  id,
  kind,
  api_version,
  created_at,
  team_id,
  origin,
  target_hint,
  dr_clean_by
)
SELECT request_id,
       'async_placeholder',
       'local',
       created_at,
       team_id,
       'async-request-placeholder',
       '<pending asynchronous request log>',
       now() + interval '24 hours'
  FROM missing_requests
ON CONFLICT (id) DO NOTHING;

CREATE FUNCTION retention_ensure_async_request_placeholder()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO requests (
    id,
    kind,
    api_version,
    created_at,
    team_id,
    origin,
    target_hint,
    dr_clean_by
  ) VALUES (
    NEW.request_id,
    'async_placeholder',
    'local',
    NEW.created_at,
    NEW.team_id,
    'async-request-placeholder',
    '<pending asynchronous request log>',
    LEAST(NEW.created_at + interval '24 hours', now() + interval '24 hours')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END
$$;

CREATE TRIGGER retention_ensure_scrapes_request
BEFORE INSERT ON scrapes
FOR EACH ROW EXECUTE FUNCTION retention_ensure_async_request_placeholder();
CREATE TRIGGER retention_ensure_parses_request
BEFORE INSERT ON parses
FOR EACH ROW EXECUTE FUNCTION retention_ensure_async_request_placeholder();
CREATE TRIGGER retention_ensure_crawls_request
BEFORE INSERT ON crawls
FOR EACH ROW EXECUTE FUNCTION retention_ensure_async_request_placeholder();
CREATE TRIGGER retention_ensure_batch_scrapes_request
BEFORE INSERT ON batch_scrapes
FOR EACH ROW EXECUTE FUNCTION retention_ensure_async_request_placeholder();
CREATE TRIGGER retention_ensure_searches_request
BEFORE INSERT ON searches
FOR EACH ROW EXECUTE FUNCTION retention_ensure_async_request_placeholder();
CREATE TRIGGER retention_ensure_extracts_request
BEFORE INSERT ON extracts
FOR EACH ROW EXECUTE FUNCTION retention_ensure_async_request_placeholder();
CREATE TRIGGER retention_ensure_maps_request
BEFORE INSERT ON maps
FOR EACH ROW EXECUTE FUNCTION retention_ensure_async_request_placeholder();
CREATE TRIGGER retention_ensure_llmstxts_request
BEFORE INSERT ON llmstxts
FOR EACH ROW EXECUTE FUNCTION retention_ensure_async_request_placeholder();
CREATE TRIGGER retention_ensure_deep_researches_request
BEFORE INSERT ON deep_researches
FOR EACH ROW EXECUTE FUNCTION retention_ensure_async_request_placeholder();
CREATE TRIGGER retention_ensure_research_paper_searches_request
BEFORE INSERT ON research_paper_searches
FOR EACH ROW EXECUTE FUNCTION retention_ensure_async_request_placeholder();
CREATE TRIGGER retention_ensure_research_paper_inspects_request
BEFORE INSERT ON research_paper_inspects
FOR EACH ROW EXECUTE FUNCTION retention_ensure_async_request_placeholder();
CREATE TRIGGER retention_ensure_research_paper_reads_request
BEFORE INSERT ON research_paper_reads
FOR EACH ROW EXECUTE FUNCTION retention_ensure_async_request_placeholder();
CREATE TRIGGER retention_ensure_research_related_papers_request
BEFORE INSERT ON research_related_papers
FOR EACH ROW EXECUTE FUNCTION retention_ensure_async_request_placeholder();
CREATE TRIGGER retention_ensure_research_github_searches_request
BEFORE INSERT ON research_github_searches
FOR EACH ROW EXECUTE FUNCTION retention_ensure_async_request_placeholder();
