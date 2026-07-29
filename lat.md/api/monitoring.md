# Change Monitoring

Monitoring turns recurring scrape or crawl targets into retained page snapshots, semantic change records, billed checks, and deduplicated notifications.

## Monitor contract

A v2 monitor is an owned schedule plus one or more scrape or crawl targets.

Targets carry stable IDs and their own scrape and crawl options. A monitor may be active, paused, or soft-deleted; stores its timezone-aware schedule, retention request, goal, webhook, and email policy; and exposes paginated checks and page results.

Forced zero-data-retention teams cannot create, update, or run monitors because comparison requires previous snapshots and diffs.

## Scheduling and overlap

Scheduling combines strict cron validation, deterministic jitter, database leases, and a one-current-check rule.

Schedules accept cron or supported natural-language intervals, use an IANA timezone, and cannot run more often than every five minutes. [[apps/api/src/services/monitoring/cron.ts#validateMonitorCron]] computes the next occurrence and validates cadence.

[[apps/api/src/services/monitoring/scheduler.ts#enqueueDueMonitorChecks]] claims due monitors in bounded database leases and spreads work with monitor-specific jitter. Atomic assignment of `current_check_id` prevents concurrent schedulers from dispatching the same monitor.

A still-running prior check yields an explicit `skipped_overlap` record and advances the schedule. Finished or stale current checks are reconciled before new work is admitted.

## Check orchestration

Monitor checks are durable coordinators that reuse normal scrape, crawl, NuQ, artifact, and billing paths.

RabbitMQ carries persistent check messages through a quorum queue with a dead-letter queue. The queue worker consumes one check at a time and [[apps/api/src/services/monitoring/runner.ts#processMonitorCheckJob]] makes terminal checks safe to redeliver.

Scrape targets enqueue one job per explicit URL. Crawl targets create ordinary backend-pinned crawl groups; discovered child pages carry monitor, check, target, and source identity so worker completion records them in the right snapshot.

A check completes only after every expected scrape result is recorded and every crawl group has no active, queued, or backlogged work.

## Page history and removal

Monitor page history distinguishes current page identity from one check's comparison result.

The monitor-page table tracks the latest scrape, last changed check, discovery source, removal state, and metadata for each URL. Check-page rows preserve `same`, `new`, `changed`, `removed`, or `error` outcomes and their previous/current scrape references.

Removed pages are emitted only after a crawl completes successfully and a formerly active page was absent from that crawl. A partial discovery run therefore cannot erase the prior page set.

## Diff and judgment

Comparison selects structured JSON or markdown semantics from the target's requested formats.

[[apps/api/src/services/monitoring/diff-orchestrator.ts#computeAndPersistPageDiff]] loads the previous retained document, computes the new status, optionally asks the change judge whether a change meets the monitor goal, and persists the diff artifact.

Markdown comparison suppresses incidental whitespace and iframe churn before producing a git-style diff. JSON comparison is key-order independent, normalizes string whitespace and Unicode, and reports only changed leaf paths.

Judgment is separate from raw change status: a page can be `changed` while `meaningful` is false. Each judgment stores confidence, reason, and selected meaningful changes.

## Credit reservation and billing

Checks reserve a conservative estimate before dispatch and settle against page-level observed work.

Estimate logic includes target limits, requested extraction and media formats, proxy mode, and optional judgment. Insufficient credits produce `skipped_no_credits` without launching target jobs.

Final cost prefers each scrape's recorded credits and falls back to monitor-specific estimates for older results. Removed pages cost zero; a persisted judgment proves the judge ran and adds its charge.

The Autumn lock is confirmed with actual usage or released when startup or stale-check recovery fails. Legacy account billing receives the same check identity for deduplication.

## Completion and recovery

Check finalization is a reconciler, not an assumption that the queue message remains alive.

[[apps/api/src/services/monitoring/runner.ts#reconcileRunningMonitorChecks]] reconstructs target progress from durable result rows and queue groups, applies removals, totals statuses and credits, sends notifications once, and clears the monitor's current check.

Running checks older than the stale deadline fail explicitly, release any credit lock, notify, and advance the schedule. Redis locks serialize finalization and notification claims, while PostgreSQL remains the durable check authority.

## Notifications and recipient consent

Monitoring separates per-page events, final summaries, and email-recipient consent.

Page and check-completed webhooks use the shared signed delivery contract. Completion delivery may be awaited and its latest delivery log is overlaid onto status responses without changing check success.

Email recipients are normalized and stored as pending, confirmed, or unsubscribed. Public confirmation and unsubscribe endpoints accept the opaque body token as their credential and use POST so passive link scanners cannot consume it.

## Monitoring invariants

Recurring work stays trustworthy by making skips, partial results, recovery, and delivery visible.

- One monitor has at most one current check.
- Schedule advancement records overlaps and insufficient-credit skips.
- Target jobs reuse ordinary queue ownership and scrape accounting.
- Page removal requires completed discovery.
- Raw change and goal-based meaningfulness remain distinct.
- Credit locks settle to actual work or are released.
- Notification retries never rewrite the check result.
