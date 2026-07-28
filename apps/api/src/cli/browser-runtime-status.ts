import { Pool, type PoolClient } from "pg";
import { z } from "zod";

import { createSocketExecutionAdapter } from "../lib/browser-runtime/execution-adapter-client";
import {
  diagnoseHostJobResultSchema,
  type DiagnoseHostJobResult,
} from "../lib/browser-runtime/execution-adapter-contracts";
import { canonicalUuidSchema } from "../lib/scrape-interact/browser-service-contracts";

export const browserRuntimeDurableStatusSchema = z.strictObject({
  activePromptJobs: z.number().int().nonnegative(),
  activeCodeJobs: z.number().int().nonnegative(),
  activeBrowserSessions: z.number().int().nonnegative(),
  activeCapabilities: z.number().int().nonnegative(),
  activeProxyGrants: z.number().int().nonnegative(),
  activeWriterLeases: z.number().int().nonnegative(),
  unknownActionOutcomes: z.number().int().nonnegative(),
  firecrawlCloudFallbackAttempts: z.literal(0),
});

type Queryable = Pick<PoolClient, "query">;

const STATUS_SQL = `
  SELECT
    count(*) FILTER (
      WHERE mode = 'prompt' AND state IN ('queued', 'starting', 'running')
    )::int AS "activePromptJobs",
    count(*) FILTER (
      WHERE mode = 'code' AND state IN ('queued', 'starting', 'running')
    )::int AS "activeCodeJobs",
    (
      SELECT count(*)::int
      FROM browser_sessions
      WHERE state IN ('creating', 'replaying', 'ready', 'executing', 'stopping')
    ) AS "activeBrowserSessions",
    (
      SELECT count(*)::int
      FROM browser_capabilities
      WHERE revoked_at IS NULL AND expires_at > now()
    ) AS "activeCapabilities",
    (
      SELECT count(*)::int
      FROM browser_proxy_grants
      WHERE revoked_at IS NULL AND expires_at > now()
    ) AS "activeProxyGrants",
    (
      SELECT count(*)::int
      FROM browser_profiles
      WHERE writer_session_id IS NOT NULL
    ) AS "activeWriterLeases",
    (
      SELECT count(*)::int
      FROM browser_interact_actions
      WHERE state = 'outcome_unknown'
    ) AS "unknownActionOutcomes"
  FROM browser_interact_runs
`;

/** @public */
export async function collectBrowserRuntimeDurableStatus(
  client: Queryable,
): Promise<z.infer<typeof browserRuntimeDurableStatusSchema>> {
  const result = await client.query(STATUS_SQL);
  if (result.rows.length !== 1) {
    throw new Error("browser_runtime_status_unavailable");
  }
  return browserRuntimeDurableStatusSchema.parse({
    ...result.rows[0],
    firecrawlCloudFallbackAttempts: 0,
  });
}

async function mergeDurableDiagnostic(
  client: Queryable,
  diagnostic: DiagnoseHostJobResult,
): Promise<DiagnoseHostJobResult> {
  const result = await client.query(
    `SELECT
       count(a.id)::int AS "callbackCount",
       count(a.id) FILTER (
         WHERE a.effect = 'side_effecting'
           AND a.state IN ('succeeded', 'outcome_unknown')
       )::int AS "browserEffectCount"
     FROM browser_interact_runs r
     LEFT JOIN browser_interact_actions a ON a.run_id = r.id
    WHERE r.correlation_id = $1
      AND r.adapter_job_id = $2
    GROUP BY r.id`,
    [diagnostic.correlationId, diagnostic.jobId],
  );
  if (result.rows.length > 1) {
    throw new Error("browser_runtime_diagnostic_ambiguous");
  }
  if (result.rows.length === 0) return diagnostic;
  return diagnoseHostJobResultSchema.parse({
    ...diagnostic,
    callbackCount: result.rows[0].callbackCount,
    browserEffectCount: result.rows[0].browserEffectCount,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const socketPath = process.env.BROWSER_EXECUTION_ADAPTER_SOCKET;
  if (!socketPath) {
    throw new Error("BROWSER_EXECUTION_ADAPTER_SOCKET is required");
  }
  if (
    !(
      args.length === 0 ||
      (args.length === 1 && args[0] === "--health-only") ||
      (args.length === 3 && args[0] === "--diagnose-host-job")
    )
  ) {
    process.stderr.write(
      "Usage: browser-runtime-status [--health-only|--diagnose-host-job <correlation-id> <job-id>]\n",
    );
    process.exitCode = 64;
    return;
  }
  const adapter = createSocketExecutionAdapter({ socketPath });
  if (args[0] === "--health-only") {
    process.stdout.write(`${JSON.stringify(await adapter.health())}\n`);
    return;
  }

  const databaseUrl = process.env.APPLICATION_DATABASE_URL;
  if (!databaseUrl) throw new Error("APPLICATION_DATABASE_URL is required");
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: "firecrawl-browser-runtime-status",
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
  try {
    if (args[0] === "--diagnose-host-job") {
      const correlationId = canonicalUuidSchema.parse(args[1]);
      const jobId = canonicalUuidSchema.parse(args[2]);
      const diagnostic = await adapter.diagnoseHostJob(correlationId, jobId);
      const merged = await mergeDurableDiagnostic(pool, diagnostic);
      process.stdout.write(`${JSON.stringify(merged)}\n`);
      return;
    }
    const status = await collectBrowserRuntimeDurableStatus(pool);
    const health = await adapter.health();
    const hostStatus = await adapter.status();
    process.stdout.write(
      `${JSON.stringify({ ...health, ...status, ...hostStatus })}\n`,
    );
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void main().catch(error => {
    const message =
      error instanceof Error ? error.message : "browser_runtime_status_failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
