import { readFile } from "node:fs/promises";

import { Pool, type PoolClient } from "pg";
import { z } from "zod";

import { interruptUnfinishedBrowserWork } from "../lib/browser-state/store";
import { createSocketExecutionAdapter } from "../lib/browser-runtime/execution-adapter-client";
import { runtimeUuidSchema } from "../lib/browser-runtime/protocol";

const activeRunSchema = z.strictObject({
  id: runtimeUuidSchema,
});

export const browserRuntimeDrainResultSchema = z.strictObject({
  cancelledHostJobs: z.number().int().nonnegative(),
  preparedActionsCancelled: z.number().int().nonnegative(),
  executingActionsUnknown: z.number().int().nonnegative(),
  runsInterrupted: z.number().int().nonnegative(),
  sessionsInterrupted: z.number().int().nonnegative(),
  capabilitiesRevoked: z.number().int().nonnegative(),
  grantsRevoked: z.number().int().nonnegative(),
  writerLeasesCleared: z.number().int().nonnegative(),
});

type DrainAdapter = {
  cancelExecutionRun(runId: string, reason: string): Promise<{ killed: true }>;
};

/** @public */
export async function drainBrowserRuntime(
  client: PoolClient,
  adapter: DrainAdapter,
  closeAdmission: () => Promise<void>,
  now = new Date(),
): Promise<z.infer<typeof browserRuntimeDrainResultSchema>> {
  await closeAdmission();
  const active = await client.query(
    `SELECT id
       FROM browser_interact_runs
      WHERE mode IN ('prompt', 'code')
        AND state IN ('starting', 'running')
        AND adapter_job_id IS NOT NULL
      ORDER BY id`,
  );
  const runs = z.array(activeRunSchema).parse(active.rows);
  for (const run of runs) {
    await adapter.cancelExecutionRun(run.id, "local runtime drain");
  }

  await client.query("BEGIN");
  try {
    const fenced = Object.assign(client, { databaseControlEpoch: 0 });
    const interrupted = await interruptUnfinishedBrowserWork(now, fenced);
    await client.query("COMMIT");
    return browserRuntimeDrainResultSchema.parse({
      cancelledHostJobs: runs.length,
      ...interrupted,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function requestAdmissionDrain(): Promise<void> {
  const tokenFile = process.env.BROWSER_ADAPTER_TOKEN_FILE;
  if (!tokenFile) throw new Error("BROWSER_ADAPTER_TOKEN_FILE is required");
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new Error("BROWSER_ADAPTER_TOKEN_FILE is invalid");
  }
  const port = process.env.PORT ?? "3002";
  const response = await fetch(
    `http://127.0.0.1:${port}/internal/browser-runtime/drain`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const body: unknown = await response.json().catch(() => null);
  if (
    response.status !== 200 ||
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 2 ||
    (body as { version?: unknown }).version !== 1 ||
    (body as { status?: unknown }).status !== "drained"
  ) {
    throw new Error("browser_runtime_admission_drain_failed");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (
    !(
      args.length === 0 ||
      (args.length === 1 && args[0] === "--force-after-api-stop")
    )
  ) {
    process.stderr.write(
      "Usage: browser-runtime-drain [--force-after-api-stop]\n",
    );
    process.exitCode = 64;
    return;
  }
  const databaseUrl = process.env.APPLICATION_DATABASE_URL;
  const socketPath = process.env.BROWSER_EXECUTION_ADAPTER_SOCKET;
  if (!databaseUrl || !socketPath) {
    throw new Error(
      "APPLICATION_DATABASE_URL and BROWSER_EXECUTION_ADAPTER_SOCKET are required",
    );
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: "firecrawl-browser-runtime-drain",
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
  const client = await pool.connect();
  try {
    const result = await drainBrowserRuntime(
      client,
      createSocketExecutionAdapter({ socketPath }),
      args[0] === "--force-after-api-stop"
        ? async () => undefined
        : requestAdmissionDrain,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  void main().catch(error => {
    const message =
      error instanceof Error ? error.message : "browser_runtime_drain_failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
