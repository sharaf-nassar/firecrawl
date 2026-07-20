import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  smallint,
  bigint,
  boolean,
  jsonb,
  numeric,
  timestamp,
  date,
  bytea,
  check,
  index,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });
const bigintNum = (name: string) => bigint(name, { mode: "number" });
const num = (name: string) => numeric(name, { mode: "number" });

// Keyless free-tier credit usage log (see keyless_credit_usage migration).
// team_id is the deterministic per-IP keyless team UUID; ip is the raw client IP.
export const keyless_credit_usage = pgTable("keyless_credit_usage", {
  id: bigintNum("id").notNull().generatedByDefaultAsIdentity(),
  team_id: uuid("team_id").notNull(),
  ip: text("ip").notNull(),
  credits_used: integer("credits_used").notNull(),
  created_at: ts("created_at").notNull().defaultNow(),
});

export const agent_sponsors = pgTable("agent_sponsors", {
  id: bigintNum("id").notNull().generatedByDefaultAsIdentity(),
  email: text("email").notNull(),
  status: text("status").notNull().default("pending"),
  verification_deadline: ts("verification_deadline").notNull(),
  agent_name: text("agent_name").notNull(),
  sandboxed_team_id: uuid("sandboxed_team_id"),
  api_key_id: bigintNum("api_key_id"),
  requesting_ip: text("requesting_ip"),
  tos_version: text("tos_version"),
  tos_hash: text("tos_hash"),
  verification_token: text("verification_token").notNull(),
  created_at: ts("created_at").defaultNow(),
  verified_at: ts("verified_at"),
  updated_at: ts("updated_at").defaultNow(),
});

export const agents = pgTable("agents", {
  id: uuid("id").notNull(),
  request_id: uuid("request_id").notNull(),
  team_id: uuid("team_id").notNull(),
  options: jsonb("options"),
  created_at: ts("created_at").notNull().defaultNow(),
  time_taken: num("time_taken").notNull(),
  credits_cost: integer("credits_cost").notNull(),
  cost_tracking: jsonb("cost_tracking"),
  is_successful: boolean("is_successful").notNull(),
  error: text("error"),
});

export const api_keys = pgTable("api_keys", {
  id: bigintNum("id").notNull().generatedByDefaultAsIdentity(),
  created_at: ts("created_at").defaultNow(),
  key: uuid("key").defaultRandom(),
  name: text("name"),
  team_id: uuid("team_id"),
  owner_id: uuid("owner_id"),
  agent_provisioned: boolean("agent_provisioned").default(false),
});

export const batch_scrapes = pgTable("batch_scrapes", {
  id: uuid("id").notNull(),
  request_id: uuid("request_id").notNull(),
  team_id: uuid("team_id").notNull(),
  created_at: ts("created_at").notNull().defaultNow(),
  num_docs: integer("num_docs").notNull(),
  credits_cost: integer("credits_cost").notNull(),
  cancelled: boolean("cancelled").notNull(),
});

export const blocklist = pgTable("blocklist", {
  id: bigintNum("id").notNull().generatedByDefaultAsIdentity(),
  data: jsonb("data").notNull(),
});

export const blocklist_hits = pgTable("blocklist_hits", {
  id: uuid("id").notNull(),
  domain: text("domain").notNull(),
  url: text("url"),
  team_id: uuid("team_id"),
  origin: text("origin"),
  created_at: ts("created_at").notNull().defaultNow(),
});

const local_owners = pgTable("local_owners", {
  id: uuid("id").primaryKey(),
  label: text("label").notNull(),
  created_at: ts("created_at").notNull().defaultNow(),
});

/** @public Durable local artifact manifest used by browser-state storage. */
export const local_artifacts = pgTable(
  "local_artifacts",
  {
    object_key: text("object_key").primaryKey(),
    owner_id: uuid("owner_id").notNull(),
    request_id: uuid("request_id"),
    job_id: uuid("job_id"),
    kind: text("kind").notNull(),
    content_type: text("content_type").notNull(),
    byte_size: bigintNum("byte_size").notNull(),
    checksum: text("checksum"),
    created_at: ts("created_at").notNull().defaultNow(),
    delete_after: ts("delete_after"),
  },
  table => [
    check(
      "local_artifacts_checksum_check",
      sql`${table.checksum} IS NULL OR ${table.checksum} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

/** @public Durable browser profile identity. */
export const browser_profiles = pgTable(
  "browser_profiles",
  {
    id: uuid("id").primaryKey(),
    owner_id: uuid("owner_id")
      .notNull()
      .references(() => local_owners.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    latest_generation_id: uuid("latest_generation_id").references(
      (): AnyPgColumn => browser_profile_generations.id,
      { onDelete: "set null" },
    ),
    writer_session_id: uuid("writer_session_id").references(
      (): AnyPgColumn => browser_sessions.id,
      { onDelete: "set null" },
    ),
    retention_expires_at: ts("retention_expires_at"),
    created_at: ts("created_at").notNull().defaultNow(),
    updated_at: ts("updated_at").notNull().defaultNow(),
  },
  table => [
    unique("browser_profiles_owner_id_name_key").on(table.owner_id, table.name),
    uniqueIndex("browser_profiles_writer_session_idx")
      .on(table.writer_session_id)
      .where(sql`${table.writer_session_id} IS NOT NULL`),
    index("browser_profiles_owner_updated_idx").on(
      table.owner_id,
      table.updated_at.desc(),
    ),
    index("browser_profiles_retention_expires_at_idx")
      .on(table.retention_expires_at)
      .where(sql`${table.retention_expires_at} IS NOT NULL`),
  ],
);

/** @public Immutable browser profile generation metadata. */
export const browser_profile_generations = pgTable(
  "browser_profile_generations",
  {
    id: uuid("id").primaryKey(),
    profile_id: uuid("profile_id")
      .notNull()
      .references(() => browser_profiles.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    state_path: text("state_path"),
    byte_size: bigintNum("byte_size").notNull(),
    checksum: text("checksum").notNull(),
    committed_at: ts("committed_at").notNull().defaultNow(),
    expires_at: ts("expires_at"),
    file_deleted_at: ts("file_deleted_at"),
  },
  table => [
    unique("browser_profile_generations_profile_id_generation_key").on(
      table.profile_id,
      table.generation,
    ),
    check(
      "browser_profile_generations_generation_check",
      sql`${table.generation} > 0`,
    ),
    check(
      "browser_profile_generations_byte_size_check",
      sql`${table.byte_size} >= 0`,
    ),
    check(
      "browser_profile_generations_checksum_check",
      sql`${table.checksum} ~ '^[a-f0-9]{64}$'`,
    ),
    index("browser_profile_generations_expires_at_idx")
      .on(table.expires_at)
      .where(sql`${table.expires_at} IS NOT NULL`),
  ],
);

/** @public Durable scrape replay envelope. */
export const browser_replay_envelopes = pgTable(
  "browser_replay_envelopes",
  {
    scrape_id: uuid("scrape_id")
      .primaryKey()
      .references((): AnyPgColumn => scrapes.id, { onDelete: "cascade" }),
    request_id: uuid("request_id")
      .notNull()
      .references((): AnyPgColumn => requests.id, { onDelete: "cascade" }),
    owner_id: uuid("owner_id")
      .notNull()
      .references(() => local_owners.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    navigation_policy_version: integer("navigation_policy_version").notNull(),
    envelope: jsonb("envelope").notNull(),
    created_at: ts("created_at").notNull().defaultNow(),
    updated_at: ts("updated_at").notNull().defaultNow(),
  },
  table => [
    check("browser_replay_envelopes_version_check", sql`${table.version} = 1`),
    check(
      "browser_replay_envelopes_navigation_policy_version_check",
      sql`${table.navigation_policy_version} = 1`,
    ),
  ],
);

/** @public Durable browser replay checkpoint metadata. */
export const browser_replay_checkpoints = pgTable(
  "browser_replay_checkpoints",
  {
    id: uuid("id").primaryKey(),
    scrape_id: uuid("scrape_id")
      .notNull()
      .unique()
      .references((): AnyPgColumn => scrapes.id, { onDelete: "cascade" }),
    request_id: uuid("request_id")
      .notNull()
      .references((): AnyPgColumn => requests.id, { onDelete: "cascade" }),
    owner_id: uuid("owner_id")
      .notNull()
      .references(() => local_owners.id, { onDelete: "cascade" }),
    envelope_version: integer("envelope_version").notNull(),
    state_path: text("state_path"),
    final_url: text("final_url").notNull(),
    fingerprint: jsonb("fingerprint").notNull(),
    checksum: text("checksum").notNull(),
    byte_size: bigintNum("byte_size").notNull(),
    created_at: ts("created_at").notNull().defaultNow(),
    expires_at: ts("expires_at").notNull(),
    file_deleted_at: ts("file_deleted_at"),
  },
  table => [
    check(
      "browser_replay_checkpoints_envelope_version_check",
      sql`${table.envelope_version} = 1`,
    ),
    check(
      "browser_replay_checkpoints_checksum_check",
      sql`${table.checksum} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "browser_replay_checkpoints_byte_size_check",
      sql`${table.byte_size} >= 0`,
    ),
    index("browser_replay_checkpoints_expires_at_idx").on(table.expires_at),
  ],
);

export const browser_sessions = pgTable(
  "browser_sessions",
  {
    id: uuid("id").primaryKey(),
    request_id: uuid("request_id")
      .notNull()
      .references((): AnyPgColumn => requests.id, { onDelete: "cascade" })
      .$defaultFn(() => ""),
    owner_id: uuid("owner_id")
      .notNull()
      .references(() => local_owners.id, { onDelete: "cascade" })
      .$defaultFn(() => ""),
    scrape_id: uuid("scrape_id").references((): AnyPgColumn => scrapes.id, {
      onDelete: "cascade",
    }),
    browser_id: text("browser_id"),
    runtime_epoch: integer("runtime_epoch").notNull().default(1),
    profile_id: uuid("profile_id").references(() => browser_profiles.id, {
      onDelete: "set null",
    }),
    profile_generation_id: uuid("profile_generation_id").references(
      () => browser_profile_generations.id,
      { onDelete: "set null" },
    ),
    replay_version: integer("replay_version").notNull().default(1),
    state: text("state").notNull().default("creating"),
    absolute_deadline_at: ts("absolute_deadline_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    idle_deadline_at: ts("idle_deadline_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    last_activity_at: ts("last_activity_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    current_run_id: uuid("current_run_id").references(
      (): AnyPgColumn => browser_interact_runs.id,
      { onDelete: "set null" },
    ),
    prompt_used: boolean("prompt_used").notNull().default(false),
    credits_used: integer("credits_used").default(0),
    prompt_credits_used: integer("prompt_credits_used").notNull().default(0),
    stream_web_view: boolean("stream_web_view").notNull().default(false),
    workspace_id: text("workspace_id"),
    context_id: text("context_id"),
    cdp_url: text("cdp_url"),
    cdp_path: text("cdp_path"),
    cdp_interactive_path: text("cdp_interactive_path"),
    created_at: ts("created_at").notNull().defaultNow(),
    updated_at: ts("updated_at").notNull().defaultNow(),
    terminal_at: ts("terminal_at"),
    terminal_reason: text("terminal_reason"),
    team_id: text("team_id"),
    status: text("status").notNull().default("active"),
    ttl_total: integer("ttl_total"),
    ttl_without_activity: integer("ttl_without_activity"),
    deleted_at: ts("deleted_at"),
  },
  table => [
    check(
      "browser_sessions_runtime_epoch_check",
      sql`${table.runtime_epoch} > 0`,
    ),
    check(
      "browser_sessions_replay_version_check",
      sql`${table.replay_version} = 1`,
    ),
    check(
      "browser_sessions_state_check",
      sql`${table.state} IN ('creating', 'replaying', 'ready', 'executing', 'stopping', 'destroyed', 'expired', 'interrupted', 'error')`,
    ),
    check(
      "browser_sessions_credits_used_check",
      sql`${table.credits_used} >= 0`,
    ),
    check(
      "browser_sessions_prompt_credits_used_check",
      sql`${table.prompt_credits_used} >= 0`,
    ),
    index("browser_sessions_owner_state_idx").on(table.owner_id, table.state),
    index("browser_sessions_scrape_created_at_idx")
      .on(table.scrape_id, table.created_at.desc())
      .where(sql`${table.scrape_id} IS NOT NULL`),
    index("browser_sessions_idle_deadline_at_idx").on(table.idle_deadline_at),
    index("browser_sessions_absolute_deadline_at_idx").on(
      table.absolute_deadline_at,
    ),
  ],
);

/** @public Durable browser Interact run state. */
export const browser_interact_runs = pgTable(
  "browser_interact_runs",
  {
    id: uuid("id").primaryKey(),
    request_id: uuid("request_id")
      .notNull()
      .references((): AnyPgColumn => requests.id, { onDelete: "cascade" }),
    owner_id: uuid("owner_id")
      .notNull()
      .references(() => local_owners.id, { onDelete: "cascade" }),
    session_id: uuid("session_id")
      .notNull()
      .references(() => browser_sessions.id, { onDelete: "cascade" }),
    scrape_id: uuid("scrape_id").references((): AnyPgColumn => scrapes.id, {
      onDelete: "cascade",
    }),
    mode: text("mode").notNull().default("prompt"),
    state: text("state").notNull(),
    language: text("language"),
    model: text("model").notNull(),
    reasoning_effort: text("reasoning_effort").notNull(),
    deadline_at: ts("deadline_at").notNull(),
    correlation_id: uuid("correlation_id").notNull(),
    adapter_process_id: integer("adapter_process_id"),
    cancelled_at: ts("cancelled_at"),
    output_reference: jsonb("output_reference"),
    artifact_references: jsonb("artifact_references")
      .notNull()
      .default(sql`'[]'::jsonb`),
    error_category: text("error_category"),
    error_detail: text("error_detail"),
    queued_at: ts("queued_at").notNull().defaultNow(),
    started_at: ts("started_at"),
    finished_at: ts("finished_at"),
  },
  table => [
    check(
      "browser_interact_runs_mode_check",
      sql`${table.mode} IN ('prompt', 'code', 'browser_operation', 'replay')`,
    ),
    check(
      "browser_interact_runs_state_check",
      sql`${table.state} IN ('queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')`,
    ),
    check(
      "browser_interact_runs_artifact_references_check",
      sql`jsonb_typeof(${table.artifact_references}) = 'array'`,
    ),
    index("browser_interact_runs_session_state_idx").on(
      table.session_id,
      table.state,
    ),
    index("browser_interact_runs_owner_state_idx").on(
      table.owner_id,
      table.state,
    ),
    index("browser_interact_runs_scrape_queued_at_idx")
      .on(table.scrape_id, table.queued_at.desc())
      .where(sql`${table.scrape_id} IS NOT NULL`),
    index("browser_interact_runs_deadline_at_idx").on(table.deadline_at),
  ],
);

/** @public Execute-once browser action ledger. */
export const browser_interact_actions = pgTable(
  "browser_interact_actions",
  {
    id: uuid("id").primaryKey(),
    request_id: uuid("request_id")
      .notNull()
      .references((): AnyPgColumn => requests.id, { onDelete: "cascade" }),
    owner_id: uuid("owner_id")
      .notNull()
      .references(() => local_owners.id, { onDelete: "cascade" }),
    run_id: uuid("run_id")
      .notNull()
      .references(() => browser_interact_runs.id, { onDelete: "cascade" }),
    session_id: uuid("session_id")
      .notNull()
      .references(() => browser_sessions.id, { onDelete: "cascade" }),
    adapter_job_id: text("adapter_job_id").notNull(),
    action_id: uuid("action_id").notNull().unique(),
    sequence: integer("sequence").notNull(),
    proposal_hash: text("proposal_hash").notNull(),
    effect: text("effect").notNull(),
    operation: jsonb("operation").notNull(),
    state: text("state").notNull(),
    result: jsonb("result"),
    page_state: jsonb("page_state"),
    error_category: text("error_category"),
    error_detail: text("error_detail"),
    prepared_at: ts("prepared_at").notNull().defaultNow(),
    executing_at: ts("executing_at"),
    finished_at: ts("finished_at"),
    created_at: ts("created_at").notNull().defaultNow(),
    updated_at: ts("updated_at").notNull().defaultNow(),
  },
  table => [
    unique("browser_interact_actions_run_id_sequence_key").on(
      table.run_id,
      table.sequence,
    ),
    unique("browser_interact_actions_run_id_action_id_key").on(
      table.run_id,
      table.action_id,
    ),
    unique("browser_interact_actions_run_id_sequence_proposal_hash_key").on(
      table.run_id,
      table.sequence,
      table.proposal_hash,
    ),
    check(
      "browser_interact_actions_sequence_check",
      sql`${table.sequence} BETWEEN 1 AND 25`,
    ),
    check(
      "browser_interact_actions_proposal_hash_check",
      sql`${table.proposal_hash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "browser_interact_actions_effect_check",
      sql`${table.effect} IN ('read_only', 'side_effecting')`,
    ),
    check(
      "browser_interact_actions_state_check",
      sql`${table.state} IN ('prepared', 'executing', 'succeeded', 'rejected_no_effect', 'failed_no_effect', 'cancelled_no_effect', 'outcome_unknown')`,
    ),
    index("browser_interact_actions_run_state_idx").on(
      table.run_id,
      table.state,
    ),
    index("browser_interact_actions_session_state_idx").on(
      table.session_id,
      table.state,
    ),
    index("browser_interact_actions_run_sequence_state_idx").on(
      table.run_id,
      table.sequence,
      table.state,
    ),
    index("browser_interact_actions_action_hash_idx").on(
      table.action_id,
      table.proposal_hash,
    ),
  ],
);

export const browser_session_activities = pgTable(
  "browser_session_activities",
  {
    id: bigintNum("id").primaryKey().generatedAlwaysAsIdentity(),
    request_id: uuid("request_id")
      .notNull()
      .references((): AnyPgColumn => requests.id, { onDelete: "cascade" })
      .$defaultFn(() => ""),
    owner_id: uuid("owner_id")
      .notNull()
      .references(() => local_owners.id, { onDelete: "cascade" })
      .$defaultFn(() => ""),
    session_id: uuid("session_id")
      .notNull()
      .references(() => browser_sessions.id, { onDelete: "cascade" }),
    run_id: uuid("run_id").references(() => browser_interact_runs.id, {
      onDelete: "cascade",
    }),
    mode: text("mode").notNull().default("prompt"),
    language: text("language"),
    timeout_ms: integer("timeout_ms").notNull().default(1),
    exit_code: integer("exit_code"),
    killed: boolean("killed").notNull().default(false),
    kill_reason: text("kill_reason"),
    source: text("source").notNull().default("browser"),
    correlation_id: uuid("correlation_id")
      .notNull()
      .$defaultFn(() => ""),
    created_at: ts("created_at").notNull().defaultNow(),
    completed_at: ts("completed_at"),
    team_id: text("team_id"),
    timeout: integer("timeout"),
  },
  table => [
    check(
      "browser_session_activities_mode_check",
      sql`${table.mode} IN ('prompt', 'code', 'browser_operation', 'replay')`,
    ),
    check(
      "browser_session_activities_timeout_ms_check",
      sql`${table.timeout_ms} > 0`,
    ),
    index("browser_session_activities_session_created_at_idx").on(
      table.session_id,
      table.created_at.desc(),
    ),
  ],
);

/** @public Hashed browser capability grants. */
export const browser_capabilities = pgTable(
  "browser_capabilities",
  {
    id: uuid("id").primaryKey(),
    token_hash: text("token_hash").notNull().unique(),
    owner_id: uuid("owner_id")
      .notNull()
      .references(() => local_owners.id, { onDelete: "cascade" }),
    session_id: uuid("session_id")
      .notNull()
      .references(() => browser_sessions.id, { onDelete: "cascade" }),
    run_id: uuid("run_id")
      .notNull()
      .references(() => browser_interact_runs.id, { onDelete: "cascade" }),
    adapter_process_id: integer("adapter_process_id").notNull(),
    operations: jsonb("operations").notNull(),
    origins: jsonb("origins").notNull(),
    navigation_policy_version: integer("navigation_policy_version").notNull(),
    call_limit: integer("call_limit").notNull(),
    calls_used: integer("calls_used").notNull().default(0),
    byte_limit: bigintNum("byte_limit").notNull(),
    bytes_used: bigintNum("bytes_used").notNull().default(0),
    wall_deadline_at: ts("wall_deadline_at").notNull(),
    per_operation_timeout_ms: integer("per_operation_timeout_ms").notNull(),
    issued_at: ts("issued_at").notNull().defaultNow(),
    redeemed_at: ts("redeemed_at"),
    revoked_at: ts("revoked_at"),
    expires_at: ts("expires_at").notNull(),
  },
  table => [
    check(
      "browser_capabilities_token_hash_check",
      sql`${table.token_hash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "browser_capabilities_operations_check",
      sql`jsonb_typeof(${table.operations}) = 'array'`,
    ),
    check(
      "browser_capabilities_origins_check",
      sql`jsonb_typeof(${table.origins}) = 'array'`,
    ),
    check(
      "browser_capabilities_navigation_policy_version_check",
      sql`${table.navigation_policy_version} = 1`,
    ),
    check(
      "browser_capabilities_call_limit_check",
      sql`${table.call_limit} > 0`,
    ),
    check(
      "browser_capabilities_calls_used_check",
      sql`${table.calls_used} >= 0 AND ${table.calls_used} <= ${table.call_limit}`,
    ),
    check(
      "browser_capabilities_byte_limit_check",
      sql`${table.byte_limit} >= 0`,
    ),
    check(
      "browser_capabilities_bytes_used_check",
      sql`${table.bytes_used} >= 0 AND ${table.bytes_used} <= ${table.byte_limit}`,
    ),
    check(
      "browser_capabilities_per_operation_timeout_ms_check",
      sql`${table.per_operation_timeout_ms} > 0`,
    ),
    index("browser_capabilities_token_hash_idx").on(table.token_hash),
    index("browser_capabilities_expires_at_idx").on(table.expires_at),
  ],
);

/** @public Hashed browser proxy grants. */
export const browser_proxy_grants = pgTable(
  "browser_proxy_grants",
  {
    id: uuid("id").primaryKey(),
    token_hash: text("token_hash").notNull().unique(),
    owner_id: uuid("owner_id")
      .notNull()
      .references(() => local_owners.id, { onDelete: "cascade" }),
    session_id: uuid("session_id")
      .notNull()
      .references(() => browser_sessions.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    use_limit: integer("use_limit").notNull(),
    uses: integer("uses").notNull().default(0),
    issued_at: ts("issued_at").notNull().defaultNow(),
    redeemed_at: ts("redeemed_at"),
    revoked_at: ts("revoked_at"),
    expires_at: ts("expires_at").notNull(),
  },
  table => [
    check(
      "browser_proxy_grants_token_hash_check",
      sql`${table.token_hash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "browser_proxy_grants_permission_check",
      sql`${table.permission} IN ('passive', 'interactive', 'cdp')`,
    ),
    check("browser_proxy_grants_use_limit_check", sql`${table.use_limit} > 0`),
    check(
      "browser_proxy_grants_uses_check",
      sql`${table.uses} >= 0 AND ${table.uses} <= ${table.use_limit}`,
    ),
    index("browser_proxy_grants_token_hash_idx").on(table.token_hash),
    index("browser_proxy_grants_expires_at_idx").on(table.expires_at),
  ],
);

export const concurrency_log = pgTable("concurrency_log", {
  id: bigintNum("id").notNull().generatedByDefaultAsIdentity(),
  created_at: ts("created_at").notNull().defaultNow(),
  team_id: uuid("team_id").notNull(),
  concurrency: integer("concurrency").notNull(),
});

export const crawls = pgTable("crawls", {
  id: uuid("id").notNull(),
  request_id: uuid("request_id").notNull(),
  url: text("url").notNull(),
  team_id: uuid("team_id").notNull(),
  options: jsonb("options"),
  created_at: ts("created_at").notNull().defaultNow(),
  num_docs: integer("num_docs").notNull(),
  credits_cost: integer("credits_cost").notNull(),
  cancelled: boolean("cancelled").notNull(),
  monitor_id: uuid("monitor_id"),
  monitor_check_id: uuid("monitor_check_id"),
});

export const deep_researches = pgTable("deep_researches", {
  id: uuid("id").notNull(),
  request_id: uuid("request_id").notNull(),
  query: text("query").notNull(),
  team_id: uuid("team_id").notNull(),
  created_at: ts("created_at").notNull().defaultNow(),
  time_taken: num("time_taken").notNull(),
  credits_cost: integer("credits_cost").notNull(),
  cost_tracking: jsonb("cost_tracking"),
  options: jsonb("options"),
});

const researchEndpointTable = (name: string) =>
  pgTable(name, {
    id: uuid("id").notNull(),
    request_id: uuid("request_id").notNull(),
    target: text("target").notNull(),
    team_id: uuid("team_id").notNull(),
    options: jsonb("options"),
    response: jsonb("response"),
    num_results: integer("num_results").notNull(),
    time_taken: num("time_taken").notNull(),
    credits_cost: integer("credits_cost").notNull(),
    is_successful: boolean("is_successful").notNull(),
    error: text("error"),
    created_at: ts("created_at").notNull().defaultNow(),
  });

export const research_paper_searches = researchEndpointTable(
  "research_paper_searches",
);

export const research_paper_inspects = researchEndpointTable(
  "research_paper_inspects",
);

export const research_paper_reads = researchEndpointTable(
  "research_paper_reads",
);

export const research_related_papers = researchEndpointTable(
  "research_related_papers",
);

export const research_github_searches = researchEndpointTable(
  "research_github_searches",
);

export const deterministic_json_scripts = pgTable(
  "deterministic_json_scripts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cache_key: text("cache_key").notNull().unique(),
    code: text("code").notNull(),
    url: text("url"),
    model: text("model"),
    cache_version: integer("cache_version"),
    created_at: ts("created_at").notNull().defaultNow(),
    updated_at: ts("updated_at").notNull().defaultNow(),
    last_used_at: ts("last_used_at").notNull().defaultNow(),
  },
);

export const deterministic_json_llm_cache = pgTable(
  "deterministic_json_llm_cache",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cache_key: text("cache_key").notNull().unique(),
    response: text("response").notNull(),
    created_at: ts("created_at").notNull().defaultNow(),
    last_used_at: ts("last_used_at").notNull().defaultNow(),
  },
);

export const eb_sync = pgTable("eb-sync", {
  id: bigintNum("id").notNull().generatedByDefaultAsIdentity(),
  created_at: ts("created_at").notNull().defaultNow(),
  team_id: text("team_id"),
});

export const extracts = pgTable("extracts", {
  id: uuid("id").notNull(),
  request_id: uuid("request_id").notNull(),
  urls: text("urls").array().notNull(),
  options: jsonb("options"),
  model_kind: text("model_kind").notNull(),
  team_id: uuid("team_id").notNull(),
  is_successful: boolean("is_successful").notNull(),
  error: text("error"),
  created_at: ts("created_at").notNull().defaultNow(),
  credits_cost: integer("credits_cost").notNull(),
  cost_tracking: jsonb("cost_tracking"),
});

export const idempotency_keys = pgTable("idempotency_keys", {
  key: uuid("key").notNull().defaultRandom(),
  created_at: ts("created_at").notNull().defaultNow(),
});

export const llm_texts = pgTable("llm_texts", {
  id: uuid("id").notNull().defaultRandom(),
  origin_url: text("origin_url").notNull(),
  llmstxt: text("llmstxt").notNull(),
  llmstxt_full: text("llmstxt_full").notNull(),
  max_urls: integer("max_urls").notNull(),
  created_at: ts("created_at").notNull().defaultNow(),
  updated_at: ts("updated_at"),
});

export const llmstxts = pgTable("llmstxts", {
  id: uuid("id").notNull(),
  request_id: uuid("request_id").notNull(),
  url: text("url").notNull(),
  team_id: uuid("team_id").notNull(),
  created_at: ts("created_at").notNull().defaultNow(),
  num_urls: integer("num_urls").notNull(),
  options: jsonb("options"),
  cost_tracking: jsonb("cost_tracking"),
  credits_cost: integer("credits_cost").notNull(),
});

export const maps = pgTable("maps", {
  id: uuid("id").notNull(),
  request_id: uuid("request_id").notNull(),
  url: text("url").notNull(),
  options: jsonb("options"),
  team_id: uuid("team_id").notNull(),
  created_at: ts("created_at").notNull().defaultNow(),
  num_results: integer("num_results").notNull(),
  credits_cost: integer("credits_cost").notNull(),
});

export const monitor_check_pages = pgTable("monitor_check_pages", {
  id: uuid("id").notNull(),
  check_id: uuid("check_id").notNull(),
  monitor_id: uuid("monitor_id").notNull(),
  team_id: uuid("team_id").notNull(),
  target_id: text("target_id").notNull(),
  url: text("url").notNull(),
  url_hash: bytea("url_hash").notNull(),
  status: text("status").notNull(),
  previous_scrape_id: uuid("previous_scrape_id"),
  current_scrape_id: uuid("current_scrape_id"),
  diff_gcs_key: text("diff_gcs_key"),
  diff_text_bytes: integer("diff_text_bytes"),
  diff_json_bytes: integer("diff_json_bytes"),
  status_code: integer("status_code"),
  error: text("error"),
  metadata: jsonb("metadata"),
  created_at: ts("created_at").notNull().defaultNow(),
  judgment: jsonb("judgment"),
});

export const monitor_checks = pgTable("monitor_checks", {
  id: uuid("id").notNull(),
  monitor_id: uuid("monitor_id").notNull(),
  team_id: uuid("team_id").notNull(),
  trigger: text("trigger").notNull(),
  status: text("status").notNull().default("queued"),
  scheduled_for: ts("scheduled_for"),
  started_at: ts("started_at"),
  finished_at: ts("finished_at"),
  estimated_credits: integer("estimated_credits"),
  reserved_credits: integer("reserved_credits"),
  actual_credits: integer("actual_credits"),
  autumn_lock_id: text("autumn_lock_id"),
  billing_status: text("billing_status").notNull().default("not_applicable"),
  total_pages: integer("total_pages").notNull().default(0),
  same_count: integer("same_count").notNull().default(0),
  changed_count: integer("changed_count").notNull().default(0),
  new_count: integer("new_count").notNull().default(0),
  removed_count: integer("removed_count").notNull().default(0),
  error_count: integer("error_count").notNull().default(0),
  target_results: jsonb("target_results"),
  webhook_payload: jsonb("webhook_payload"),
  email_payload: jsonb("email_payload"),
  notification_status: jsonb("notification_status"),
  error: text("error"),
  created_at: ts("created_at").notNull().defaultNow(),
  updated_at: ts("updated_at").notNull().defaultNow(),
});

export const monitor_email_recipients = pgTable("monitor_email_recipients", {
  id: uuid("id").notNull().defaultRandom(),
  monitor_id: uuid("monitor_id").notNull(),
  team_id: uuid("team_id").notNull(),
  email: text("email").notNull(),
  status: text("status").notNull().default("pending"),
  token: text("token").notNull(),
  source: text("source").notNull().default("opt_in"),
  confirmation_sent_at: ts("confirmation_sent_at"),
  confirmed_at: ts("confirmed_at"),
  unsubscribed_at: ts("unsubscribed_at"),
  last_notified_at: ts("last_notified_at"),
  created_at: ts("created_at").notNull().defaultNow(),
  updated_at: ts("updated_at").notNull().defaultNow(),
});

export const monitor_pages = pgTable("monitor_pages", {
  id: uuid("id").notNull().defaultRandom(),
  monitor_id: uuid("monitor_id").notNull(),
  team_id: uuid("team_id").notNull(),
  target_id: text("target_id").notNull(),
  url: text("url").notNull(),
  url_hash: bytea("url_hash").notNull(),
  source: text("source").notNull(),
  first_seen_check_id: uuid("first_seen_check_id"),
  last_seen_check_id: uuid("last_seen_check_id"),
  last_changed_check_id: uuid("last_changed_check_id"),
  last_scrape_id: uuid("last_scrape_id"),
  last_status: text("last_status").notNull(),
  is_removed: boolean("is_removed").notNull().default(false),
  removed_at: ts("removed_at"),
  metadata: jsonb("metadata"),
  created_at: ts("created_at").notNull().defaultNow(),
  updated_at: ts("updated_at").notNull().defaultNow(),
});

export const monitors = pgTable("monitors", {
  id: uuid("id").notNull(),
  team_id: uuid("team_id").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  schedule_cron: text("schedule_cron").notNull(),
  schedule_timezone: text("schedule_timezone").notNull().default("UTC"),
  next_run_at: ts("next_run_at"),
  last_run_at: ts("last_run_at"),
  last_check_id: uuid("last_check_id"),
  current_check_id: uuid("current_check_id"),
  locked_at: ts("locked_at"),
  locked_until: ts("locked_until"),
  retention_days: integer("retention_days").notNull().default(30),
  estimated_credits_per_month: integer("estimated_credits_per_month"),
  targets: jsonb("targets").notNull().default([]),
  webhook: jsonb("webhook"),
  notification: jsonb("notification"),
  last_check_summary: jsonb("last_check_summary"),
  created_at: ts("created_at").notNull().defaultNow(),
  updated_at: ts("updated_at").notNull().defaultNow(),
  deleted_at: ts("deleted_at"),
  goal: text("goal"),
  judge_enabled: boolean("judge_enabled").notNull().default(false),
});

export const notification_preferences = pgTable("notification_preferences", {
  id: uuid("id").notNull().defaultRandom(),
  user_id: uuid("user_id").notNull(),
  last_referral_notification: ts("last_referral_notification"),
  created_at: ts("created_at").notNull().defaultNow(),
  updated_at: ts("updated_at").notNull().defaultNow(),
  email_preferences: text("email_preferences")
    .array()
    .default(["rate_limit_warnings", "system_alerts"]),
  unsubscribed_all: boolean("unsubscribed_all").default(false),
});

export const parses = pgTable("parses", {
  id: uuid("id").notNull(),
  request_id: uuid("request_id").notNull(),
  url: text("url").notNull(),
  is_successful: boolean("is_successful").notNull(),
  error: text("error"),
  time_taken: num("time_taken").notNull(),
  team_id: uuid("team_id").notNull(),
  options: jsonb("options"),
  cost_tracking: jsonb("cost_tracking"),
  pdf_num_pages: integer("pdf_num_pages"),
  credits_cost: integer("credits_cost").notNull(),
  created_at: ts("created_at").notNull().defaultNow(),
});

export const prices = pgTable("prices", {
  id: text("id").notNull(),
  product_id: text("product_id"),
  active: boolean("active").notNull().default(true),
  description: text("description"),
  unit_amount: bigintNum("unit_amount"),
  currency: text("currency").default("usd"),
  type: text("type").default("recurring"),
  interval: text("interval"),
  interval_count: integer("interval_count").default(1),
  trial_period_days: integer("trial_period_days").default(0),
  metadata: jsonb("metadata").default({}),
  credits: integer("credits").default(50),
  is_usage: boolean("is_usage").default(false),
  rate_limits: jsonb("rate_limits"),
  concurrency: integer("concurrency"),
  plan_priority: jsonb("plan_priority"),
  upfront: boolean("upfront").default(false),
  slug: text("slug")
    .notNull()
    .default(sql`gen_random_uuid()`),
  should_be_graceful: boolean("should_be_graceful").default(false),
  created_at: ts("created_at").notNull().defaultNow(),
  updated_at: ts("updated_at").notNull().defaultNow(),
  unit_amount_rollover_cap: smallint("unit_amount_rollover_cap")
    .notNull()
    .default(0),
  associated_auto_recharge_price_id: text("associated_auto_recharge_price_id"),
  exp_pack_max_per_month: integer("exp_pack_max_per_month"),
});

export const products = pgTable("products", {
  id: text("id").notNull(),
  active: boolean("active").notNull().default(true),
  name: text("name"),
  description: text("description"),
  image: text("image"),
  metadata: jsonb("metadata").notNull().default({}),
  order: smallint("order"),
  test_mode: boolean("test_mode").default(true),
  is_enterprise: boolean("is_enterprise").default(false),
  is_extract: boolean("is_extract").default(false),
  is_displayed: boolean("is_displayed").default(false),
  is_stripe_test: boolean("is_stripe_test").default(false),
  slug: text("slug"),
  updated_at: ts("updated_at").notNull().defaultNow(),
  type: text("type"),
});

export const requests = pgTable("requests", {
  id: uuid("id").notNull(),
  kind: text("kind").notNull(),
  api_version: text("api_version").notNull(),
  created_at: ts("created_at").notNull().defaultNow(),
  team_id: uuid("team_id").notNull(),
  origin: text("origin").notNull(),
  integration: text("integration"),
  target_hint: text("target_hint").notNull(),
  dr_clean_by: ts("dr_clean_by"),
  api_key_id: bigintNum("api_key_id"),
});

export const scrapes = pgTable("scrapes", {
  id: uuid("id").notNull(),
  request_id: uuid("request_id").notNull(),
  url: text("url").notNull(),
  is_successful: boolean("is_successful").notNull(),
  error: text("error"),
  time_taken: num("time_taken").notNull(),
  team_id: uuid("team_id").notNull(),
  options: jsonb("options"),
  cost_tracking: jsonb("cost_tracking"),
  pdf_num_pages: integer("pdf_num_pages"),
  credits_cost: integer("credits_cost").notNull(),
  created_at: ts("created_at").notNull().defaultNow(),
  monitor_id: uuid("monitor_id"),
  monitor_check_id: uuid("monitor_check_id"),
  content_type: text("content_type"),
});

export const search_feedback = pgTable("search_feedback", {
  id: uuid("id").notNull().defaultRandom(),
  search_id: uuid("search_id"),
  endpoint: text("endpoint").notNull().default("search"),
  job_id: uuid("job_id"),
  request_id: uuid("request_id"),
  api_version: text("api_version").default("v2"),
  team_id: uuid("team_id").notNull(),
  api_key_id: bigintNum("api_key_id"),
  overall_rating: text("overall_rating").notNull(),
  issue_types: text("issue_types").array().notNull().default([]),
  tags: text("tags").array().notNull().default([]),
  comment: text("comment"),
  valuable_sources: jsonb("valuable_sources").notNull().default([]),
  missing_content: jsonb("missing_content").notNull().default([]),
  query_suggestions: text("query_suggestions"),
  metadata: jsonb("metadata").notNull().default({}),
  job_status: text("job_status"),
  credits_billed: integer("credits_billed").notNull().default(0),
  integration: text("integration"),
  origin: text("origin"),
  credits_refunded: integer("credits_refunded").notNull().default(0),
  refund_policy: jsonb("refund_policy"),
  created_at: ts("created_at").notNull().defaultNow(),
  updated_at: ts("updated_at").notNull().defaultNow(),
});

export const searches = pgTable("searches", {
  id: uuid("id").notNull(),
  request_id: uuid("request_id").notNull(),
  query: text("query").notNull(),
  team_id: uuid("team_id").notNull(),
  options: jsonb("options"),
  time_taken: num("time_taken").notNull(),
  created_at: ts("created_at").notNull().defaultNow(),
  credits_cost: integer("credits_cost").notNull(),
  is_successful: boolean("is_successful").notNull(),
  error: text("error"),
  num_results: integer("num_results").notNull(),
});

export const subscriptions = pgTable("subscriptions", {
  id: text("id").notNull(),
  user_id: uuid("user_id").notNull(),
  status: text("status"),
  metadata: jsonb("metadata"),
  price_id: text("price_id"),
  quantity: integer("quantity"),
  cancel_at_period_end: boolean("cancel_at_period_end"),
  created: ts("created").notNull().defaultNow(),
  current_period_start: ts("current_period_start").notNull().defaultNow(),
  current_period_end: ts("current_period_end").notNull().defaultNow(),
  ended_at: ts("ended_at").defaultNow(),
  cancel_at: ts("cancel_at").defaultNow(),
  canceled_at: ts("canceled_at").defaultNow(),
  trial_start: ts("trial_start").defaultNow(),
  trial_end: ts("trial_end").defaultNow(),
  team_id: uuid("team_id"),
  is_usage: boolean("is_usage").default(false),
  is_extract: boolean("is_extract").default(false),
  updated_at: ts("updated_at").notNull().defaultNow(),
  expansion_associated_coupon: bigintNum("expansion_associated_coupon"),
  pending_price_id: text("pending_price_id"),
  pending_price_effective_at: ts("pending_price_effective_at"),
  pending_schedule_id: text("pending_schedule_id"),
});

export const teams = pgTable("teams", {
  id: uuid("id").notNull().defaultRandom(),
  created_at: ts("created_at").defaultNow(),
  name: text("name"),
  banned: boolean("banned").default(false),
  idmux_expires_at: ts("idmux_expires_at"),
  updated_at: ts("updated_at").defaultNow(),
  hmac_secret: text("hmac_secret")
    .notNull()
    .default(sql`encode(extensions.gen_random_bytes(32), 'hex'::text)`),
  referrer_integration: varchar("referrer_integration"),
  allocated_concurrent_browsers: integer("allocated_concurrent_browsers"),
  org_id: uuid("org_id").notNull(),
});

export const user_notifications = pgTable("user_notifications", {
  id: uuid("id").notNull().defaultRandom(),
  team_id: uuid("team_id"),
  notification_type: text("notification_type").notNull(),
  sent_date: date("sent_date", { mode: "string" }).notNull(),
  email_id: text("email_id"),
  timestamp: ts("timestamp"),
  read: boolean("read").default(false),
  metadata: jsonb("metadata"),
});

export const user_teams = pgTable("user_teams", {
  user_id: uuid("user_id").notNull(),
  team_id: uuid("team_id").notNull(),
  role: text("role").default("admin"),
  created_at: ts("created_at").defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").notNull(),
  full_name: text("full_name"),
  avatar_url: text("avatar_url"),
  billing_address: jsonb("billing_address"),
  payment_method: jsonb("payment_method"),
  email: text("email"),
  team_id: uuid("team_id"),
  created_on: ts("created_on").defaultNow(),
  referrer_integration: varchar("referrer_integration"),
});

export const webhook_logs = pgTable("webhook_logs", {
  id: uuid("id").notNull().defaultRandom(),
  success: boolean("success").notNull(),
  error: text("error"),
  team_id: uuid("team_id").notNull(),
  crawl_id: uuid("crawl_id").notNull(),
  scrape_id: uuid("scrape_id"),
  request_id: uuid("request_id"),
  dr_clean_by: ts("dr_clean_by").notNull(),
  created_at: ts("created_at").notNull().defaultNow(),
  url: text("url").notNull(),
  status_code: smallint("status_code"),
  event: text("event").notNull(),
  latency_ms: integer("latency_ms").default(0),
});
