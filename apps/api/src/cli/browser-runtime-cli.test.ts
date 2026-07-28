import { describe, expect, it, vi } from "vitest";

import { drainBrowserRuntime } from "./browser-runtime-drain";
import { collectBrowserRuntimeDurableStatus } from "./browser-runtime-status";

describe("browser runtime lifecycle CLI", () => {
  it("returns one closed durable status record", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          activePromptJobs: 1,
          activeCodeJobs: 2,
          activeBrowserSessions: 3,
          activeCapabilities: 2,
          activeProxyGrants: 1,
          activeWriterLeases: 1,
          unknownActionOutcomes: 0,
        },
      ],
    }));
    await expect(
      collectBrowserRuntimeDurableStatus({ query } as never),
    ).resolves.toEqual({
      activePromptJobs: 1,
      activeCodeJobs: 2,
      activeBrowserSessions: 3,
      activeCapabilities: 2,
      activeProxyGrants: 1,
      activeWriterLeases: 1,
      unknownActionOutcomes: 0,
      firecrawlCloudFallbackAttempts: 0,
    });
  });

  it("rejects unknown status fields", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          activePromptJobs: 0,
          activeCodeJobs: 0,
          activeBrowserSessions: 0,
          activeCapabilities: 0,
          activeProxyGrants: 0,
          activeWriterLeases: 0,
          unknownActionOutcomes: 0,
          secret: "leak",
        },
      ],
    }));
    await expect(
      collectBrowserRuntimeDurableStatus({ query } as never),
    ).rejects.toThrow();
  });

  it("cancels bound host jobs before durable interruption", async () => {
    const trace: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        const normalized = sql.trim();
        trace.push(normalized.split(/\s+/u).slice(0, 3).join(" "));
        if (normalized.startsWith("SELECT id")) {
          return {
            rows: [
              { id: "0198f37a-5a9c-7b20-8000-000000000001" },
              { id: "0198f37a-5a9c-7b20-8000-000000000002" },
            ],
          };
        }
        if (normalized.startsWith("UPDATE browser_interact_actions")) {
          return { rows: [] };
        }
        if (normalized.startsWith("UPDATE browser_interact_runs")) {
          return { rows: [] };
        }
        if (normalized.startsWith("UPDATE browser_sessions")) {
          return { rows: [] };
        }
        if (normalized.startsWith("UPDATE browser_capabilities")) {
          return { rows: [] };
        }
        if (normalized.startsWith("UPDATE browser_proxy_grants")) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const adapter = {
      cancelExecutionRun: vi.fn(async (runId: string) => {
        trace.push(`cancel ${runId}`);
        return { killed: true as const };
      }),
    };

    await expect(
      drainBrowserRuntime(client as never, adapter, async () => {
        trace.push("admission drained");
      }),
    ).resolves.toMatchObject({ cancelledHostJobs: 2 });
    expect(trace.slice(0, 4)).toEqual([
      "admission drained",
      "SELECT id FROM",
      "cancel 0198f37a-5a9c-7b20-8000-000000000001",
      "cancel 0198f37a-5a9c-7b20-8000-000000000002",
    ]);
    expect(trace.at(-1)).toBe("COMMIT");
  });

  it("rolls back when durable interruption fails", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        const normalized = sql.trim();
        if (normalized.startsWith("SELECT id")) return { rows: [] };
        if (normalized.startsWith("UPDATE browser_interact_actions")) {
          throw new Error("database unavailable");
        }
        return { rows: [] };
      }),
    };
    await expect(
      drainBrowserRuntime(
        client as never,
        { cancelExecutionRun: vi.fn() },
        async () => undefined,
      ),
    ).rejects.toThrow("database unavailable");
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
  });
});
