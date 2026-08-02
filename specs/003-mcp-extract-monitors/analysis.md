# Analysis: mcp-extract-monitors

Quick-depth alignment analysis of `spec.md` vs `plan.md` after the single-pass review applied its must-fixes directly to the plan.

## Coverage Table

| User story / requirement | Covered by (plan section) | Status |
|---|---|---|
| Story 1: extract via Codex Shim (success on example.com, shim-served) | Architecture Approach #1; Sequencing items 2, 4, 6 | FULL |
| Story 1 AC: chat-completions only, no `/responses` or `/v1/embeddings` traffic | Testing Strategy (chat-mode routing unit test); Sequencing item 2; API / Interface Changes | FULL |
| Story 1 AC: empty-string base-URL config regression test | Testing Strategy (config regression); Sequencing item 1 | FULL |
| Story 1 AC: codex-dedupe human precondition | Risks (host codex PATH ambiguity); Sequencing item 6 preconditions | FULL |
| Story 2: monitors/feedback hidden from `tools/list`, `-32601` on direct call | Architecture Approach #2; Sequencing item 3; Testing Strategy (launcher) | FULL |
| Story 2 AC: no monitor 500s in local API logs | Testing Strategy (live acceptance, observational); Sequencing item 6 AC | FULL |
| Story 3: launcher test suite enumerates all 17 names, passes | Sequencing item 3; Testing Strategy (launcher literals + count) | FULL |
| Story 3 AC: `lat check` green with updated lat.md | Sequencing item 5; Affected Components (lat.md files itemized) | FULL |
| Goal: empty `OPENAI_BASE_URL`/`OLLAMA_BASE_URL` behave as unset (Q3) | Sequencing item 1; Affected Components (`config.ts:71,325`) | FULL |
| Goal: acceptance evidence = config regression test + recorded manual rerun (Q4) | Testing Strategy (evidence format defined post-fix); Sequencing item 6 AC | FULL |
| Constraint: 2026-08-01 baseline tools keep passing | Testing Strategy + Sequencing item 6 (added post-fix) | FULL |
| Constraint: fixtures/test literals force explicit drift review, not weakened | Sequencing item 3; Affected Components (`local-firecrawl-mcp.test.mjs`) | FULL |
| Constraint: names preserved for future enablement; wrapper-only stack ops | Architecture Approach #2; Testing Strategy (live acceptance) | FULL |
| Non-goals (no shim `/responses`, no monitor backing, no hosted OpenAI, no shim lifecycle mgmt) | Architecture Approach (alternatives rejected); Data Model; Risks | FULL — no scope creep |

## Backlog Disposition

| Source id | Plan work item(s) | Disposition | Ready to resolve? |
|---|---|---|---|
| firecrawl-dsw (P2 bug, extract base URL) | Items 1, 2, 4 (verified by item 6) | Split-and-supersede | Yes |
| firecrawl-4e1 (P2 task, monitor/feedback disable) | Item 3 | Refine-in-place | Yes |

Both are P2 direct sources feeding this spec — there are no P4 backlog sources for this run.

## Target Epic

New epic bead, created at bead-creation time, owning plan items 1-6 as P0-P3 tasks with the plan's dependency edges. firecrawl-dsw is superseded by its replacement task beads (items 1/2/4) with provenance links; firecrawl-4e1 is refined in place as item 3's bead under the epic. Candidate follow-ups recorded on the epic but outside it: server-side monitor deployment gate, `local-firecrawl health` shim probe, future local monitor enablement.

## Remaining Risks

- **Chat-mode flag regresses hosted Responses usage** — mitigated by an explicit default-off flag plus a flag-off unit test; rollback story is defined (unset/false the flag and revert the env-template line restores the Responses default; the empty-string hardening needs no rollback path).
- **JSON-schema structured output vs shim schema-file path unverified** — whether ai-sdk's chat schema mode maps onto `createCodexTranslator`'s per-call schema files is only provable in the live run; the manual acceptance rerun (item 6) is the verification gate, with translator parsing as a bounded follow-up if it fails.
- **Human prerequisites gate the final acceptance item** — host codex PATH ambiguity must be deduped, the shim must be running (no in-repo supervisor), and the concrete `MODEL_NAME` value needs human confirmation; these block item 6 only, not code work.
- **Fire-0 legacy extract path parity** — must be confirmed during implementation to share `getModel` (or be unreachable locally); the acceptance evidence records which pipeline executed.
- **Shim queue/timeout tolerance** — concurrency-2 FIFO serializes extract fan-out; risk-only (no code work item), mitigated by trivial acceptance extract and a documented known limitation.

## Unresolved Questions

- Concrete `MODEL_NAME` value for the local env template — implementer proposes a codex-supported model, human confirms at implementation time (item 4 AC forbids a commented placeholder). Nothing else remains open: Q1-Q4 are clarified, the chat-mode mechanism is decided (explicit flag), and the remaining spec Open Questions (fire-0 parity, schema-mode compatibility, shim health probe) are carried as risks or follow-up beads rather than blockers.

## Constitution Check

No constitution.md — skipped.

## Recommendation

**GO.** The plan covers every goal, story AC, constraint, and clarification answer with no gaps after the applied fixes (evidence format, baseline-regression coverage, rollback story, item-4 AC tightening), and no work item violates a spec non-goal. Sequencing is a clean DAG (items 1/2/3 parallel on disjoint files, 4→2, 5 fans in from 1-4, 6 terminal), each of the six items carries verifiable acceptance criteria fit for P0-P3 beads, and both P2 sources have unambiguous dispositions. Residual risks are either gated by the recorded manual rerun or are human-owned environment prerequisites that block only the terminal acceptance item — nothing blocks bead creation or implementation start.
