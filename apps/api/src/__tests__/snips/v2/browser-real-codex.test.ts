import { Client } from "pg";

import { config } from "../../../config";
import { shouldRunRealCodexBrowserSmoke } from "../../../harness-browser-command";
import { TEST_SUITE_WEBSITE } from "../lib";
import {
  idmux,
  scrapeInteractRaw,
  scrapeIdFromRawResponse,
  scrapeRaw,
  scrapeStopInteractiveBrowserRaw,
  scrapeTimeout,
  type Identity,
} from "./lib";
import { RealAdapterFixture } from "./real-adapter-fixture";
import {
  cleanupTrackedResources,
  throwTrackedCleanupFailures,
  type TrackedCleanupFailure,
} from "./tracked-cleanup";

const RUN_REAL_SMOKE = shouldRunRealCodexBrowserSmoke(process.env);
const describeRealSmoke = RUN_REAL_SMOKE ? describe : describe.skip;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXACT_PROMPT_OUTPUT = "CODEX_BROWSER_FIXTURE_OK";
const EXACT_CODE_STDOUT = "Firecrawl Test Site\n";
const CODE_SOURCE = 'console.log(await page.locator("h1").textContent());';

type AdapterBinding = {
  adapterJobId: string;
  adapterSupervisorId: string;
  adapterProcessId: number;
};

type InvalidBindingProbe = {
  status: number;
  error: string;
  actionRowCount: number;
  browserServiceEffectCount: number;
};

type PromptScenarioTrace = {
  contractVersion: 1;
  scenarioId: string;
  runId: string;
  sessionId: string;
  binding: AdapterBinding;
  model: string;
  reasoningEffort: string;
  protocol: {
    toolEventCount: number;
    approvalEventCount: number;
    mcpEventCount: number;
  };
  firstValidCallback: {
    status: number;
    actionRowCountBefore: number;
    browserServiceEffectCountBefore: number;
  };
  invalidBindings: {
    job: InvalidBindingProbe;
    supervisor: InvalidBindingProbe;
    process: InvalidBindingProbe;
  };
  matchingReplay: {
    status: number;
    sameObservation: boolean;
    effectCountBefore: number;
    effectCountAfter: number;
    proposalHash: string;
  };
  hashMismatch: {
    status: number;
    error: string;
    originalHash: string;
    mismatchedHash: string;
    effectCountBefore: number;
    effectCountAfter: number;
  };
  adapterRestart: {
    oldBinding: AdapterBinding;
    oldHeadersStatus: number;
    oldHeadersError: string;
    oldHeadersEffectCount: number;
    newBinding: AdapterBinding;
    newHeadersStatus: number;
  };
  browserServiceEffectCount: number;
  cleanup: {
    activeCapabilities: number;
    activeProxyGrants: number;
    activeWriterLeases: number;
    adapterProcessAlive: boolean;
    browserRuntimeAlive: boolean;
  };
};

type CodeScenarioKind =
  | "code_success"
  | "code_cancel"
  | "code_wrong_binding"
  | "code_stale_binding"
  | "code_writer_busy"
  | "code_gate_closed"
  | "code_connect_failure";

type CodeScenarioTrace = {
  contractVersion: 1;
  scenarioId: string;
  runId: string;
  sessionId: string;
  events: string[];
  internalCdpOpenCount: number;
  sourceStartsBeforeAcceptance: number;
  sourceStartsBeforeRelayReady: number;
  sourceProcessCount: number;
  maxConcurrentBrowserWriters: number;
  activeBrowserWriters: number;
  activeRelayGrants: number;
  writerReleased: boolean;
  sourceProcessAlive: boolean;
  bindingStatus?: number;
  failureCategory?: string;
};

type BrowserRunRow = {
  id: string;
  session_id: string;
  state: string;
  model: string;
  reasoning_effort: string;
  adapter_job_id: string;
  adapter_supervisor_id: string;
  adapter_process_id: number;
  output_reference: {
    version: number;
    mode: string;
    output?: string;
    turnCount?: number;
    actionCount?: number;
    protocol?: {
      toolEventCount: number;
      approvalEventCount: number;
      decisionSchemaVersion: number;
      observationSchemaVersion: number;
    };
  };
};

type BrowserActionRow = {
  action_id: string;
  adapter_job_id: string;
  sequence: number;
  proposal_hash: string;
  effect: "read_only" | "side_effecting";
  state: string;
};

type CapabilityRow = {
  adapter_job_id: string;
  adapter_supervisor_id: string;
  adapter_process_id: number;
  activated_at: Date;
  revoked_at: Date | null;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required when RUN_REAL_CODEX_BROWSER_SMOKE=1`);
  }
  return value;
}

function requireUuid(value: unknown, name: string): string {
  expect(value, `${name} must be returned by the post-host API`).toEqual(
    expect.stringMatching(CANONICAL_UUID),
  );
  return value as string;
}

async function queryOne<T>(
  client: Client,
  text: string,
  values: unknown[],
): Promise<T> {
  const result = await client.query<T & Record<string, unknown>>(text, values);
  expect(result.rows).toHaveLength(1);
  return result.rows[0] as T;
}

async function createControlledScrape(
  identity: Identity,
  scrapes: Set<string>,
): Promise<string> {
  const response = await scrapeRaw(
    {
      url: TEST_SUITE_WEBSITE,
      origin: "website-browser-real-codex-smoke",
      formats: ["markdown"],
      maxAge: 0,
    },
    identity,
  );
  const returnedScrapeId = scrapeIdFromRawResponse(response.body);
  if (typeof returnedScrapeId === "string") {
    scrapes.add(returnedScrapeId);
  }
  expect(response.statusCode).toBe(200);
  expect(response.body.success).toBe(true);
  return requireUuid(returnedScrapeId, "scrapeId");
}

function expectBinding(actual: AdapterBinding, expected: AdapterBinding) {
  expect(actual).toEqual(expected);
  expect(actual.adapterJobId).toMatch(CANONICAL_UUID);
  expect(actual.adapterSupervisorId).toMatch(CANONICAL_UUID);
  expect(actual.adapterProcessId).toBeGreaterThan(0);
}

function expectInvalidBindingProbe(probe: InvalidBindingProbe) {
  expect(probe).toEqual({
    status: 403,
    error: "capability_denied",
    actionRowCount: 0,
    browserServiceEffectCount: 0,
  });
}

function expectRelayOrdering(trace: CodeScenarioTrace) {
  const accepted = trace.events.indexOf("adapter_accepted");
  const relayReady = trace.events.indexOf("relay_ready");
  const sourceStarted = trace.events.indexOf("source_started");
  const sourceExited = trace.events.indexOf("source_exited");
  const writerReleased = trace.events.indexOf("writer_released");
  expect(accepted).toBeGreaterThanOrEqual(0);
  expect(relayReady).toBeGreaterThan(accepted);
  expect(sourceStarted).toBeGreaterThan(relayReady);
  expect(sourceExited).toBeGreaterThan(sourceStarted);
  expect(writerReleased).toBeGreaterThan(sourceExited);
}

describeRealSmoke("post-host real Codex browser contract", () => {
  let identity: Identity;
  let database: Client;
  let fixture: RealAdapterFixture;
  const scenarios = new Set<string>();
  const scrapes = new Set<string>();

  async function cleanupSmokeResources(): Promise<
    Array<TrackedCleanupFailure<unknown>>
  > {
    const failures: Array<TrackedCleanupFailure<unknown>> = [];
    if (identity) {
      failures.push(
        ...(await cleanupTrackedResources(scrapes, "scrape", async scrapeId => {
          const response = await scrapeStopInteractiveBrowserRaw(
            scrapeId,
            identity,
          );
          if (response.statusCode !== 200 || response.body.success !== true) {
            throw new Error(
              `Scrape ${scrapeId} cleanup returned ${response.statusCode}`,
            );
          }
        })),
      );
    }
    if (fixture) {
      failures.push(
        ...(await cleanupTrackedResources(
          scenarios,
          "adapter-scenario",
          scenarioId => fixture.release(scenarioId),
        )),
      );
    }
    return failures;
  }

  async function stopTrackedScrape(scrapeId: string): Promise<void> {
    const response = await scrapeStopInteractiveBrowserRaw(scrapeId, identity);
    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    scrapes.delete(scrapeId);
  }

  beforeAll(async () => {
    expect(config.TEST_SUITE_SELF_HOSTED).toBe(true);
    expect(config.LOCAL_BROWSER_SERVICE_ENABLED).toBe(true);
    const databaseUrl =
      config.APPLICATION_DATABASE_URL ??
      requiredEnvironment("APPLICATION_DATABASE_URL");
    fixture = new RealAdapterFixture(
      requiredEnvironment("REAL_CODEX_BROWSER_TEST_ADAPTER_URL"),
      requiredEnvironment("REAL_CODEX_BROWSER_TEST_ADAPTER_TOKEN"),
    );
    database = new Client({ connectionString: databaseUrl });
    await database.connect();
    identity = await idmux({
      name: "browser-real-codex",
      concurrency: 4,
      credits: 1_000,
    });
  });

  afterEach(async () => {
    throwTrackedCleanupFailures(await cleanupSmokeResources());
  });

  afterAll(async () => {
    const failures = await cleanupSmokeResources();
    try {
      await database?.end();
    } catch (error) {
      failures.push({ resource: "database", id: "connection", error });
    }
    throwTrackedCleanupFailures(failures);
  });

  it(
    "locks real Codex and preserves one contiguous execute-once action ledger",
    async () => {
      const scrapeId = await createControlledScrape(identity, scrapes);
      const scenario = await fixture.begin("prompt_contract");
      scenarios.add(scenario.scenarioId);

      const response = await scrapeInteractRaw(
        scrapeId,
        {
          prompt: [
            `Controlled fixture marker: ${scenario.marker}.`,
            'Click the link whose visible text is "about page".',
            `After the page loads, return exactly ${EXACT_PROMPT_OUTPUT}`,
            "with no punctuation, explanation, or additional text.",
          ].join(" "),
          timeout: 60,
          origin: "browser-real-codex-smoke",
        },
        identity,
      );

      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        output: EXACT_PROMPT_OUTPUT,
      });
      const runId = requireUuid(response.body.runId, "runId");
      const sessionId = requireUuid(response.body.sessionId, "sessionId");

      const run = await queryOne<BrowserRunRow>(
        database,
        `SELECT id::text, session_id::text, state, model, reasoning_effort,
                adapter_job_id::text, adapter_supervisor_id::text,
                adapter_process_id, output_reference
           FROM browser_interact_runs
          WHERE id = $1`,
        [runId],
      );
      expect(run).toMatchObject({
        id: runId,
        session_id: sessionId,
        state: "succeeded",
        model: "gpt-5.6-terra",
        reasoning_effort: "medium",
      });
      expect(run.output_reference).toMatchObject({
        version: 1,
        mode: "prompt",
        output: EXACT_PROMPT_OUTPUT,
        protocol: {
          toolEventCount: 0,
          approvalEventCount: 0,
          decisionSchemaVersion: 1,
          observationSchemaVersion: 1,
        },
      });

      const actionResult = await database.query<BrowserActionRow>(
        `SELECT action_id::text, adapter_job_id::text, sequence,
                proposal_hash, effect, state
           FROM browser_interact_actions
          WHERE run_id = $1
          ORDER BY sequence`,
        [runId],
      );
      const actions = actionResult.rows;
      expect(actions.length).toBeGreaterThan(0);
      expect(run.output_reference.actionCount).toBe(actions.length);
      expect(run.output_reference.turnCount).toBe(actions.length + 1);
      expect(actions.map(action => action.sequence)).toEqual(
        actions.map((_, index) => index + 1),
      );
      expect(actions.every(action => action.state === "succeeded")).toBe(true);
      expect(
        actions.every(action => action.adapter_job_id === run.adapter_job_id),
      ).toBe(true);
      expect(new Set(actions.map(action => action.action_id)).size).toBe(
        actions.length,
      );
      expect(actions.some(action => action.effect === "side_effecting")).toBe(
        true,
      );

      const capability = await queryOne<CapabilityRow>(
        database,
        `SELECT adapter_job_id::text, adapter_supervisor_id::text,
                adapter_process_id, activated_at, revoked_at
           FROM browser_capabilities
          WHERE run_id = $1
          ORDER BY issued_at DESC
          LIMIT 1`,
        [runId],
      );
      expect(capability).toMatchObject({
        adapter_job_id: run.adapter_job_id,
        adapter_supervisor_id: run.adapter_supervisor_id,
        adapter_process_id: run.adapter_process_id,
      });
      expect(capability.activated_at).not.toBeNull();

      const trace = await fixture.promptTrace<PromptScenarioTrace>(
        scenario.scenarioId,
      );
      expect(trace).toMatchObject({
        contractVersion: 1,
        scenarioId: scenario.scenarioId,
        runId,
        sessionId,
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
        protocol: {
          toolEventCount: 0,
          approvalEventCount: 0,
          mcpEventCount: 0,
        },
      });
      expectBinding(trace.binding, {
        adapterJobId: run.adapter_job_id,
        adapterSupervisorId: run.adapter_supervisor_id,
        adapterProcessId: run.adapter_process_id,
      });
      expect(trace.browserServiceEffectCount).toBe(actions.length);

      expect(trace.firstValidCallback).toMatchObject({
        status: 200,
        actionRowCountBefore: 0,
        browserServiceEffectCountBefore: 0,
      });
      expectInvalidBindingProbe(trace.invalidBindings.job);
      expectInvalidBindingProbe(trace.invalidBindings.supervisor);
      expectInvalidBindingProbe(trace.invalidBindings.process);

      expect(trace.matchingReplay).toMatchObject({
        status: 200,
        sameObservation: true,
      });
      expect(trace.matchingReplay.effectCountAfter).toBe(
        trace.matchingReplay.effectCountBefore,
      );
      expect(trace.matchingReplay.proposalHash).toMatch(/^[a-f0-9]{64}$/);
      expect(trace.hashMismatch).toMatchObject({
        status: 502,
        error: "model_protocol_error",
      });
      expect(trace.hashMismatch.originalHash).not.toBe(
        trace.hashMismatch.mismatchedHash,
      );
      expect(trace.hashMismatch.effectCountAfter).toBe(
        trace.hashMismatch.effectCountBefore,
      );

      expect(trace.adapterRestart.oldHeadersStatus).toBe(403);
      expect(trace.adapterRestart.oldHeadersError).toBe("capability_denied");
      expect(trace.adapterRestart.oldHeadersEffectCount).toBe(0);
      expect(trace.adapterRestart.newHeadersStatus).toBe(200);
      expect(trace.adapterRestart.oldBinding).not.toEqual(
        trace.adapterRestart.newBinding,
      );
      expectBinding(trace.adapterRestart.newBinding, trace.binding);

      const bindingBeforeStop = {
        adapter_job_id: run.adapter_job_id,
        adapter_supervisor_id: run.adapter_supervisor_id,
        adapter_process_id: run.adapter_process_id,
      };
      const firstStop = await scrapeStopInteractiveBrowserRaw(
        scrapeId,
        identity,
      );
      const duplicateStop = await scrapeStopInteractiveBrowserRaw(
        scrapeId,
        identity,
      );
      expect(firstStop.statusCode).toBe(200);
      expect(firstStop.body.success).toBe(true);
      expect(duplicateStop.statusCode).toBe(200);
      expect(duplicateStop.body.success).toBe(true);
      scrapes.delete(scrapeId);

      await fixture.waitForPhase(scenario.scenarioId, "cleaned");
      const cleanedTrace = await fixture.promptTrace<PromptScenarioTrace>(
        scenario.scenarioId,
      );
      expect(cleanedTrace.cleanup).toEqual({
        activeCapabilities: 0,
        activeProxyGrants: 0,
        activeWriterLeases: 0,
        adapterProcessAlive: false,
        browserRuntimeAlive: false,
      });
      const cleanup = await queryOne<{
        session_state: string;
        current_run_id: string | null;
        active_capabilities: number;
        active_proxy_grants: number;
        writer_leases: number;
        adapter_job_id: string;
        adapter_supervisor_id: string;
        adapter_process_id: number;
      }>(
        database,
        `SELECT session.state AS session_state,
                session.current_run_id::text,
                (SELECT count(*)::int
                   FROM browser_capabilities capability
                  WHERE capability.session_id = session.id
                    AND capability.revoked_at IS NULL) AS active_capabilities,
                (SELECT count(*)::int
                   FROM browser_proxy_grants grant_row
                  WHERE grant_row.session_id = session.id
                    AND grant_row.revoked_at IS NULL) AS active_proxy_grants,
                (SELECT count(*)::int
                   FROM browser_profiles profile
                  WHERE profile.writer_session_id = session.id) AS writer_leases,
                run.adapter_job_id::text,
                run.adapter_supervisor_id::text,
                run.adapter_process_id
           FROM browser_sessions session
           JOIN browser_interact_runs run ON run.id = $2
          WHERE session.id = $1`,
        [sessionId, runId],
      );
      expect(cleanup).toMatchObject({
        session_state: "destroyed",
        current_run_id: null,
        active_capabilities: 0,
        active_proxy_grants: 0,
        writer_leases: 0,
        ...bindingBeforeStop,
      });
    },
    scrapeTimeout * 2,
  );

  it(
    "opens CDP only after acceptance and releases its sole writer",
    async () => {
      const scrapeId = await createControlledScrape(identity, scrapes);
      const scenario = await fixture.begin("code_success");
      scenarios.add(scenario.scenarioId);
      const response = await scrapeInteractRaw(
        scrapeId,
        {
          code: `${CODE_SOURCE}\n// fixture:${scenario.marker}`,
          language: "node",
          timeout: 30,
          origin: "browser-real-code-smoke",
        },
        identity,
      );
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        stdout: EXACT_CODE_STDOUT,
        result: "",
        stderr: "",
        exitCode: 0,
        killed: false,
      });
      const runId = requireUuid(response.body.runId, "runId");
      const sessionId = requireUuid(response.body.sessionId, "sessionId");
      const trace = await fixture.codeTrace<CodeScenarioTrace>(
        scenario.scenarioId,
      );
      expect(trace).toMatchObject({
        contractVersion: 1,
        scenarioId: scenario.scenarioId,
        runId,
        sessionId,
        internalCdpOpenCount: 1,
        sourceStartsBeforeAcceptance: 0,
        sourceStartsBeforeRelayReady: 0,
        sourceProcessCount: 1,
        maxConcurrentBrowserWriters: 1,
        activeBrowserWriters: 0,
        activeRelayGrants: 0,
        writerReleased: true,
        sourceProcessAlive: false,
      });
      expectRelayOrdering(trace);
      await stopTrackedScrape(scrapeId);
    },
    scrapeTimeout,
  );

  it(
    "cancellation kills source and releases relay writer ownership",
    async () => {
      const scrapeId = await createControlledScrape(identity, scrapes);
      const scenario = await fixture.begin("code_cancel");
      scenarios.add(scenario.scenarioId);
      const execution = scrapeInteractRaw(
        scrapeId,
        {
          code: [
            CODE_SOURCE,
            "await new Promise(resolve => setTimeout(resolve, 300000));",
            `// fixture:${scenario.marker}`,
          ].join("\n"),
          language: "node",
          timeout: 300,
          origin: "browser-real-code-cancel-smoke",
        },
        identity,
      );
      await fixture.waitForPhase(scenario.scenarioId, "source_started");
      await stopTrackedScrape(scrapeId);
      const response = await execution;
      expect(response.statusCode).not.toBe(200);
      await fixture.waitForPhase(scenario.scenarioId, "cleaned");
      const trace = await fixture.codeTrace<CodeScenarioTrace>(
        scenario.scenarioId,
      );
      expect(trace).toMatchObject({
        internalCdpOpenCount: 1,
        sourceStartsBeforeAcceptance: 0,
        sourceStartsBeforeRelayReady: 0,
        sourceProcessCount: 1,
        maxConcurrentBrowserWriters: 1,
        activeBrowserWriters: 0,
        activeRelayGrants: 0,
        writerReleased: true,
        sourceProcessAlive: false,
      });
      expectRelayOrdering(trace);
    },
    scrapeTimeout,
  );

  it.each<{
    kind: CodeScenarioKind;
    expectedCategory: string;
    expectedBindingStatus?: number;
  }>([
    {
      kind: "code_wrong_binding",
      expectedCategory: "capability_denied",
      expectedBindingStatus: 403,
    },
    {
      kind: "code_stale_binding",
      expectedCategory: "capability_denied",
      expectedBindingStatus: 403,
    },
    {
      kind: "code_writer_busy",
      expectedCategory: "writer_busy",
    },
    {
      kind: "code_gate_closed",
      expectedCategory: "browser_state_unavailable",
    },
    {
      kind: "code_connect_failure",
      expectedCategory: "browser_unavailable",
    },
  ])(
    "creates no source process or relay grant for $kind",
    async ({ kind, expectedCategory, expectedBindingStatus }) => {
      const scrapeId = await createControlledScrape(identity, scrapes);
      const scenario = await fixture.begin(kind);
      scenarios.add(scenario.scenarioId);
      const response = await scrapeInteractRaw(
        scrapeId,
        {
          code: `${CODE_SOURCE}\n// fixture:${scenario.marker}`,
          language: "node",
          timeout: 30,
          origin: `browser-real-${kind}`,
        },
        identity,
      );
      expect(response.statusCode).not.toBe(200);
      await fixture.waitForPhase(scenario.scenarioId, "cleaned");
      const trace = await fixture.codeTrace<CodeScenarioTrace>(
        scenario.scenarioId,
      );
      expect(trace).toMatchObject({
        failureCategory: expectedCategory,
        sourceStartsBeforeAcceptance: 0,
        sourceStartsBeforeRelayReady: 0,
        sourceProcessCount: 0,
        activeBrowserWriters: 0,
        activeRelayGrants: 0,
        writerReleased: true,
        sourceProcessAlive: false,
      });
      if (expectedBindingStatus !== undefined) {
        expect(trace.bindingStatus).toBe(expectedBindingStatus);
      }
      await stopTrackedScrape(scrapeId);
    },
    scrapeTimeout,
  );
});
