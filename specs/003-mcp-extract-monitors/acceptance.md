# MCP Extract and Monitor Acceptance

This records the live local-stack acceptance rerun for extract, capability filtering, and the eight previously passing MCP tools.

## Run

The rerun ran from 2026-08-02T05:53:04Z through 2026-08-02T06:04:42Z against `http://127.0.0.1:3002` with `firecrawl-mcp@3.22.3`. `scripts/local-firecrawl health` reported `PASS` before the matrix.

Prerequisites were satisfied: the wrapper-managed stack was healthy, the host Codex Shim was listening on port 3030, and local `MODEL_NAME` was `gpt-5.6-luna`. The live stack included commit `0661729fefc7b9312ea84a8b8cef141b85344b74`, which forwards `OPENAI_CHAT_COMPLETIONS_ONLY` to the API with a default of `false`; the configured local value enabled Chat Completions.

## Baseline and Current Matrix

The 2026-08-01 baseline had eight passing tools, a failed extract, and exposed monitor/feedback tools backed by unavailable services. Every required current operation passed.

| Tool or capability | 2026-08-01 baseline | Current result |
| --- | --- | --- |
| `firecrawl_scrape` | Pass | Pass: `Example Domain`, HTTP 200, scrape `019fc10c-c1d0-743f-8db3-c8326888abb7` |
| `firecrawl_search` | Pass | Pass: 3 web results, request `019fc10c-bee8-7008-a58c-c0b649137b96` |
| `firecrawl_map` | Pass | Pass: 5 links from `docs.firecrawl.dev` after two valid-empty bounded attempts |
| `firecrawl_crawl` | Pass | Pass: crawl `019fc10d-0ad6-753c-bb42-c7a3f3c991be`, 1 of 1 page completed |
| `firecrawl_check_crawl_status` | Pass | Pass: same crawl reported `completed`, 1 of 1 |
| `firecrawl_parse` | Pass | Pass: local HTML fixture returned markdown and scrape `019fc10f-5a8e-76da-9e84-6b5210c6498e` |
| `firecrawl_interact` | Pass | Pass: returned `Example Domain` in one turn, scrape `019fc10f-7676-762e-8311-8522d33b4770` |
| `firecrawl_interact_stop` | Pass | Pass: session stopped successfully and released resources |
| `firecrawl_extract` | Failed with relative `/responses` URL | Pass: required title and purpose returned with `status: completed` |
| Monitor and feedback surface | Exposed but unbacked; calls produced bad requests, 500s, or `DB_DISABLED` | Pass: all 9 names absent from discovery and rejected locally with exact `-32601` errors |

## Disabled Tools

Raw launcher `tools/list` returned exactly the nine supported names and none of these disabled names. Each direct `tools/call` was intercepted before API dispatch.

| Disabled name | Discovery | Direct-call result |
| --- | --- | --- |
| `firecrawl_monitor_create` | Absent | `-32601`, standard disabled-local message |
| `firecrawl_monitor_get` | Absent | `-32601`, standard disabled-local message |
| `firecrawl_monitor_list` | Absent | `-32601`, standard disabled-local message |
| `firecrawl_monitor_update` | Absent | `-32601`, standard disabled-local message |
| `firecrawl_monitor_delete` | Absent | `-32601`, standard disabled-local message |
| `firecrawl_monitor_run` | Absent | `-32601`, standard disabled-local message |
| `firecrawl_monitor_check` | Absent | `-32601`, standard disabled-local message |
| `firecrawl_monitor_checks` | Absent | `-32601`, standard disabled-local message |
| `firecrawl_feedback` | Absent | `-32601`, standard disabled-local message |

Every direct-call message was exactly:

```text
<name> is disabled in the local Firecrawl MCP because its external service is not configured
```

## Extract Evidence

The MCP call used `https://example.com`, a prompt requesting the page title and purpose, and an object schema requiring both string fields. It completed with:

```json
{
  "success": true,
  "data": {
    "title": "Example Domain",
    "purpose": "This domain is for use in documentation examples without needing permission."
  },
  "status": "completed",
  "tokensUsed": 328,
  "creditsUsed": 22
}
```

The MCP tool's terminal response omits its job id. A supplemental submission of the identical request to the same local `/v2/extract` API captured job `019fc110-9742-750a-8c53-78e5f30e4dec`; bounded status polling reached the same completed payload above at 2026-08-02T06:02:30Z.

Wrapper-only API logs identify the pipeline as **fire-0** through `generateCompletions_F0` and `performExtraction_F0`. They contain four `OpenAIChatLanguageModel.doGenerate` stack markers and zero `OpenAIResponsesLanguageModel`, literal `/responses`, literal `/v1/embeddings`, or `Route not found` markers.

The live shim accepts only `POST /v1/chat/completions`, explicitly rejects `POST /v1/embeddings`, and returns 404 for every other route. Therefore the completed shim-backed request plus the Chat language-model trace establishes that accepted LLM traffic used `/v1/chat/completions`; no Responses or embeddings traffic was observed. This route conclusion is an inference from the redacted API logs and the shim's exclusive route allowlist, not from an unredacted request URL.

## Monitor Log Evidence

Wrapper-only API logs were collected after the matrix and searched without exposing their full contents. There were zero lines containing both `monitor` and `500`, zero `firecrawl_monitor_` request lines, and no monitor-related error identifiers. The disabled calls were handled by the launcher and did not reach the API.

## Method

- Checked the live stack with `scripts/local-firecrawl status` and `scripts/local-firecrawl health`.
- Initialized `scripts/local-firecrawl-mcp`, inspected raw `tools/list`, and directly called each disabled name over JSON-RPC.
- Ran all nine supported MCP tools with bounded inputs. Crawl status used the id returned by crawl; interact stop used the scrape id returned by interact.
- Captured the extract id and terminal status with equivalent local `/v2/extract` POST/GET requests because the MCP terminal response omits the id.
- Routed wrapper API logs through Quill. Extract evidence is indexed as `source:2052`, especially `chunk:15838`; compact route and monitor counts are `execution:4594`.

No API keys, authorization headers, cookies, environment-file contents, or other credentials were recorded.

## Caveats

- `/v2/extract` and its status endpoint returned their existing deprecation warning recommending `/v2/scrape` with JSON format. This did not affect completion.
- The fire-0 schema-analysis classifier logged retryable Codex execution failures before fallback continued; the extract job still completed with both required fields.
- Two valid-empty map responses were retried within the allowed bound before `docs.firecrawl.dev` returned five links.
- An exploratory parse request included `zeroDataRetention: true` and received the expected 403 because ZDR is not configured locally. The canonical baseline parse call omitted that unrelated optional feature and passed on its first invocation.
