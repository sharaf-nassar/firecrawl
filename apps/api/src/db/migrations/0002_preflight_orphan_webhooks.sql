WITH resolved_webhooks AS (
  SELECT webhook.id AS webhook_id, resolved.request_id
    FROM webhook_logs AS webhook
    CROSS JOIN LATERAL (
      SELECT candidate.request_id
        FROM (
          SELECT request_id, 1 AS priority
            FROM crawls
           WHERE id = webhook.crawl_id
          UNION ALL
          SELECT request_id, 2
            FROM batch_scrapes
           WHERE id = webhook.crawl_id
          UNION ALL
          SELECT request_id, 3
            FROM extracts
           WHERE id = webhook.crawl_id
          UNION ALL
          SELECT request_id, 4
            FROM scrapes
           WHERE id = webhook.crawl_id
          UNION ALL
          SELECT request_id, 5
            FROM scrapes
           WHERE id = webhook.scrape_id
        ) AS candidate
       ORDER BY candidate.priority
       LIMIT 1
    ) AS resolved
)
DELETE FROM webhook_logs AS webhook
 USING resolved_webhooks AS resolved
 WHERE webhook.id = resolved.webhook_id
   AND NOT EXISTS (
     SELECT 1
       FROM requests AS parent
      WHERE parent.id = resolved.request_id
   );
