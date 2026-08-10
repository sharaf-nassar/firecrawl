import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CodexProtocolError,
  createCodexTranslator,
  normalizeChatRequest,
} from "./translate.mjs";
import { mapModel } from "./model-map.mjs";
import {
  createCodexShimServer,
  isCodexRuntimeReady,
  readServerConfig,
} from "./server.mjs";

async function makeFakeCodex(t, mode = "success") {
  const root = await mkdtemp(join(tmpdir(), "codex-shim-test-"));
  const bin = join(root, "bin");
  const log = join(root, "events.jsonl");
  await mkdir(bin, { mode: 0o700 });
  await symlink(process.execPath, join(bin, "node"));
  await writeFile(
    join(bin, "codex"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { prompt += chunk; });
process.stdin.on("end", async () => {
  const schemaIndex = args.indexOf("--output-schema");
  const schemaPath = schemaIndex === -1 ? null : args[schemaIndex + 1];
  const record = {
    phase: "start",
    args,
    prompt,
    schemaPath,
    schema: schemaPath === null ? null : fs.readFileSync(schemaPath, "utf8"),
  };
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(record) + "\\n");
  const delay = prompt.includes("[USER]\\nfirst") ? 80 : 5;
  await new Promise(resolve => setTimeout(resolve, delay));
  if (process.env.FAKE_CODEX_MODE === "failed") {
    process.stderr.write("AUTH_SECRET_MUST_NOT_ESCAPE\\n");
    process.exitCode = 9;
    return;
  }
  if (process.env.FAKE_CODEX_MODE === "malformed") {
    process.stdout.write("not-json\\n");
    return;
  }
  if (process.env.FAKE_CODEX_MODE === "missing-message") {
    process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
    return;
  }
  const content = schemaPath === null
    ? "stub completion"
    : JSON.stringify({ answer: "schema-ok" });
  process.stdout.write(JSON.stringify({
    type: "thread.started",
    thread_id: "stub-thread",
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: { id: "item-1", type: "agent_message", text: content },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 11, cached_input_tokens: 2, output_tokens: 3 },
  }) + "\\n");
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({
    phase: "end",
    prompt,
  }) + "\\n");
});
`,
    { mode: 0o755 },
  );

  const previous = {
    path: process.env.PATH,
    log: process.env.FAKE_CODEX_LOG,
    mode: process.env.FAKE_CODEX_MODE,
  };
  process.env.PATH = `${bin}:${previous.path}`;
  process.env.FAKE_CODEX_LOG = log;
  process.env.FAKE_CODEX_MODE = mode;
  t.after(async () => {
    process.env.PATH = previous.path;
    if (previous.log === undefined) delete process.env.FAKE_CODEX_LOG;
    else process.env.FAKE_CODEX_LOG = previous.log;
    if (previous.mode === undefined) delete process.env.FAKE_CODEX_MODE;
    else process.env.FAKE_CODEX_MODE = previous.mode;
    await rm(root, { force: true, recursive: true });
  });
  return { log };
}

async function readEvents(path) {
  const source = await readFile(path, "utf8");
  return source
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function makeCodexRuntime(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-runtime-test-"));
  const packageDirectory = join(root, "node_modules", "@openai", "codex");
  const bin = join(packageDirectory, "bin");
  const pathBin = join(root, "bin");
  const home = join(root, "home");
  const authPath = join(home, ".codex", "auth.json");
  await mkdir(bin, { mode: 0o700, recursive: true });
  await mkdir(pathBin, { mode: 0o700 });
  await mkdir(join(home, ".codex"), { mode: 0o700, recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "@openai/codex",
      bin: { codex: "bin/codex.js" },
    }),
    { mode: 0o600 },
  );
  await writeFile(join(bin, "codex.js"), "#!/usr/bin/env node\n", {
    mode: 0o755,
  });
  await symlink(join(bin, "codex.js"), join(pathBin, "codex"));
  await writeFile(authPath, "AUTH_FILE_SECRET_MUST_NOT_ESCAPE\n", {
    mode: 0o600,
  });
  t.after(() => rm(root, { force: true, recursive: true }));
  return { authPath, env: { HOME: home, PATH: pathBin } };
}

async function startShim(t, { maxConcurrency = 2, runtimeReady } = {}) {
  const config = readServerConfig({
    CODEX_SHIM_HOST: "127.0.0.1",
    CODEX_SHIM_PORT: "0",
    CODEX_SHIM_MAX_CONCURRENCY: String(maxConcurrency),
  });
  const shim = createCodexShimServer(config, undefined, runtimeReady);
  const address = await shim.listen();
  t.after(() => shim.close());
  return `http://127.0.0.1:${address.port}`;
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

// @lat: [[runtime-operations#Codex Shim suite]]
test("translates OpenAI messages and requested execution settings", async (t) => {
  const fake = await makeFakeCodex(t);
  const translator = createCodexTranslator();
  const result = await translator.complete({
    model: "gpt-4.1",
    reasoning_effort: "high",
    messages: [
      { role: "system", content: "Follow the format." },
      {
        role: "user",
        content: [{ type: "text", text: "Return a greeting." }],
      },
    ],
  });

  assert.equal(result.object, "chat.completion");
  assert.equal(result.model, "gpt-4.1");
  assert.equal(result.choices[0].message.content, "stub completion");
  assert.deepEqual(result.usage, {
    prompt_tokens: 11,
    completion_tokens: 3,
    total_tokens: 14,
  });
  const [event] = await readEvents(fake.log);
  assert.deepEqual(event.args, [
    "exec",
    "--ephemeral",
    "--json",
    "-m",
    "gpt-5.6-terra",
    "-c",
    "model_reasoning_effort=medium",
    "-",
  ]);
  assert.equal(
    event.prompt,
    "[SYSTEM]\nFollow the format.\n\n[USER]\nReturn a greeting.",
  );
});

// @lat: [[runtime-operations#Codex Shim suite#Model routing and health surface]]
test("maps incoming names to the configured small and main tiers", () => {
  assert.deepEqual(mapModel("gpt-4o-mini"), {
    model: "gpt-5.6-luna",
    effort: "low",
  });
  assert.deepEqual(mapModel("gpt-4.1"), {
    model: "gpt-5.6-terra",
    effort: "medium",
  });
  assert.deepEqual(mapModel("unknown"), {
    model: "gpt-5.6-terra",
    effort: "medium",
  });
  assert.deepEqual(
    mapModel("vendor/nano", { small: "small-override", main: "main-override" }),
    { model: "small-override", effort: "low" },
  );
});

test("writes the exact JSON schema and removes its temporary directory", async (t) => {
  const fake = await makeFakeCodex(t);
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };
  const result = await createCodexTranslator().complete({
    model: "gpt-test-main",
    messages: [{ role: "user", content: "Return JSON." }],
    response_format: {
      type: "json_schema",
      json_schema: { name: "answer", strict: true, schema },
    },
  });

  assert.deepEqual(JSON.parse(result.choices[0].message.content), {
    answer: "schema-ok",
  });
  const [event] = await readEvents(fake.log);
  assert.deepEqual(JSON.parse(event.schema), schema);
  await assert.rejects(access(event.schemaPath), { code: "ENOENT" });
});

test("rejects malformed or missing Codex final messages", async (t) => {
  await makeFakeCodex(t, "malformed");
  await assert.rejects(
    createCodexTranslator().complete({
      model: "gpt-test-main",
      messages: [{ role: "user", content: "Hello." }],
    }),
    CodexProtocolError,
  );
  process.env.FAKE_CODEX_MODE = "missing-message";
  await assert.rejects(
    createCodexTranslator().complete({
      model: "gpt-test-main",
      messages: [{ role: "user", content: "Hello again." }],
    }),
    CodexProtocolError,
  );
});

test("runs queued Codex children in FIFO order at the configured cap", async (t) => {
  const fake = await makeFakeCodex(t);
  const translator = createCodexTranslator({ maxConcurrency: 1 });
  const request = (content) => ({
    model: "gpt-test-main",
    messages: [{ role: "user", content }],
  });
  await Promise.all([
    translator.complete(request("first")),
    translator.complete(request("second")),
    translator.complete(request("third")),
  ]);

  const events = await readEvents(fake.log);
  assert.deepEqual(
    events.map((event) => [
      event.phase,
      /\[USER\]\n([a-z]+)/u.exec(event.prompt)?.[1],
    ]),
    [
      ["start", "first"],
      ["end", "first"],
      ["start", "second"],
      ["end", "second"],
      ["start", "third"],
      ["end", "third"],
    ],
  );
});

test("serves a chat completion and rejects embeddings", async (t) => {
  await makeFakeCodex(t);
  const baseUrl = await startShim(t);
  const chat = await postJson(`${baseUrl}/v1/chat/completions`, {
    model: "gpt-test-main",
    messages: [{ role: "user", content: "Hello." }],
  });
  assert.equal(chat.response.status, 200);
  assert.match(chat.body.id, /^chatcmpl-[0-9a-f]{32}$/u);
  assert.equal(chat.body.choices[0].finish_reason, "stop");

  const embeddings = await postJson(`${baseUrl}/v1/embeddings`, {
    model: "unused",
    input: "hello",
  });
  assert.equal(embeddings.response.status, 501);
  assert.equal(embeddings.body.error.code, "not_implemented");
});

test("lists both tiers and reports secret-safe runtime health", async (t) => {
  const runtime = await makeCodexRuntime(t);
  const runtimeReady = () =>
    isCodexRuntimeReady({
      codexBin: "codex",
      env: runtime.env,
      uid: process.getuid(),
    });
  const baseUrl = await startShim(t, { runtimeReady });

  const modelsResponse = await fetch(`${baseUrl}/v1/models`);
  const models = await modelsResponse.json();
  assert.equal(modelsResponse.status, 200);
  assert.deepEqual(
    models.data.map(({ id }) => id),
    ["gpt-5.6-luna", "gpt-5.6-terra"],
  );

  const healthyResponse = await fetch(`${baseUrl}/health`);
  const healthy = await healthyResponse.json();
  assert.equal(healthyResponse.status, 200);
  assert.deepEqual(healthy, {
    status: "ok",
    backend: "codex-shim",
    models: { small: "gpt-5.6-luna", main: "gpt-5.6-terra" },
    concurrency: 2,
  });

  await chmod(runtime.authPath, 0o644);
  const unsafeResponse = await fetch(`${baseUrl}/health`);
  assert.equal(unsafeResponse.status, 503);
  await chmod(runtime.authPath, 0o600);
  await rm(runtime.authPath);
  const absentResponse = await fetch(`${baseUrl}/health`);
  const absent = await absentResponse.json();
  assert.equal(absentResponse.status, 503);
  assert.deepEqual(absent, {
    status: "unavailable",
    backend: "codex-shim",
  });

  assert.doesNotMatch(
    JSON.stringify({ models, healthy, absent }),
    /AUTH_FILE_SECRET_MUST_NOT_ESCAPE|\.codex/u,
  );
});

test("maps backend failures to secret-safe OpenAI errors", async (t) => {
  await makeFakeCodex(t, "failed");
  const baseUrl = await startShim(t);
  const secret = "Bearer AUTH_HEADER_MUST_NOT_ESCAPE";
  const result = await postJson(
    `${baseUrl}/v1/chat/completions`,
    {
      model: "gpt-test-main",
      messages: [{ role: "user", content: "Hello." }],
    },
    { authorization: secret },
  );

  assert.equal(result.response.status, 502);
  assert.equal(result.body.error.type, "server_error");
  assert.equal(result.body.error.code, "codex_failed");
  const serialized = JSON.stringify(result.body);
  assert.doesNotMatch(serialized, /AUTH_SECRET_MUST_NOT_ESCAPE/u);
  assert.doesNotMatch(serialized, /AUTH_HEADER_MUST_NOT_ESCAPE/u);
});

test("maps malformed Codex output to a protocol error response", async (t) => {
  await makeFakeCodex(t, "malformed");
  const baseUrl = await startShim(t);
  const result = await postJson(`${baseUrl}/v1/chat/completions`, {
    model: "gpt-test-main",
    messages: [{ role: "user", content: "Hello." }],
  });
  assert.equal(result.response.status, 502);
  assert.deepEqual(result.body.error, {
    message: "Codex returned malformed output.",
    type: "server_error",
    param: null,
    code: "codex_protocol_error",
  });
});

test("validates unsupported OpenAI request features", () => {
  assert.throws(
    () =>
      normalizeChatRequest({
        model: "gpt-test-main",
        messages: [{ role: "user", content: "Hello." }],
        stream: true,
      }),
    (error) =>
      error?.name === "InvalidChatRequestError" && error?.param === "stream",
  );
});

test("uses documented network and concurrency defaults", () => {
  assert.deepEqual(readServerConfig({}), {
    host: "0.0.0.0",
    port: 3030,
    maxConcurrency: 2,
    codexBin: "codex",
    models: { small: "gpt-5.6-luna", main: "gpt-5.6-terra" },
  });
  assert.deepEqual(
    readServerConfig({
      CODEX_SHIM_SMALL_MODEL: "small-override",
      CODEX_SHIM_MAIN_MODEL: "main-override",
    }).models,
    { small: "small-override", main: "main-override" },
  );
});
