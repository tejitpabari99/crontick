---
status: draft
summary: Ten tasks - webhook schema and CLI flags, payload framing util, SSE parser, relay manager and lifecycle, event guards (HMAC/dedupe/rate limit), trigger surfaces, redaction and export, status and run rendering, dashboard, tests/docs/ADR/changeset.
date: 2026-10-08
---
# Tasks: SP06 Webhook trigger and relay
Source of truth: docs/agent_files/users-tejitpabari-crontick-improvements-20261007-0034/06-webhook-trigger/PRD.md. No [OPEN] items remain. Two items are [DEFERRED: verify during implementation] and are carried as explicit verify steps in Tasks 5 (HMAC over smee, burst/dedupe tuning). Depends on SP05 (`TriggerDispatcher`, `RunContext`, `runs.trigger_json`, `isTimeSchedule` guards), SP01 (`resolveJobRef`, `SCHEDULE_FLAGS`), SP04 (`job-prepare.ts`, `SCHEDULE_KINDS`) and SP03 (request guard on `/trigger` and `/relay/new`; `redactValue` unchanged). No new runtime dependencies.

| # | Task | Depends on | Status |
|---|---|---|---|
| 1 | `webhook` schedule kind, schema, CLI flags, `--relay auto` | - | todo |
| 2 | Webhook payload util (framing, cap, env, header allowlist) | - | todo |
| 3 | Hand-written SSE client | - | todo |
| 4 | Relay manager, `syncRelays` lifecycle, in-memory status | 1, 2, 3 | todo |
| 5 | Event guards: HMAC, dedupe, burst limit | 2, 4 | todo |
| 6 | Trigger surfaces: client, CLI, MCP, API, surface parity | 1, 2 | todo |
| 7 | Redaction and export/import stripping | 1 | todo |
| 8 | Status and trigger rendering: `jobs get`, `runs get`, `doctor` | 4, 6, 7 | todo |
| 9 | Dashboard Webhook kind, Create channel, Trigger now | 1, 6, 7, 8 | todo |
| 10 | Tests, docs, ADR 0036, changeset | 1-9 | todo |

## Task 1 — `webhook` schedule kind, schema, CLI flags, `--relay auto`
What it is / what it means: The job model and CLI input for the new kind (R1, R2, D3).
What changes at a high level: Add `WebhookScheduleSchema` (`relay` optional https URL, http only for loopback hosts; `secret` optional) to `ScheduleSchema`, exclusive with cron/every/at/after. `isTimeSchedule` is false for it, so there is no tick and no missed-fire; add `webhook` to SP05's exhaustive switches and to the schedule label (`webhook (relay: …)` / `webhook (local only)`, next run null). Add `--webhook`, `--relay <url|auto>`, `--webhook-secret` to `commonJobOptions`, append to `SCHEDULE_FLAGS` and the `jobs new` footer; the latter two without `--webhook` are errors. `--relay auto` GETs `smee.io/new` without following redirects, stores the `Location`, prints it once as a secret. No `--relay` means local-trigger-only.
Done when: Schema accepts webhook and rejects combinations; flag errors covered; `--relay auto` stores the redirect target with a fake fetch; omitted relay is valid.

## Task 2 — Webhook payload util (framing, cap, env, header allowlist)
What it is / what it means: One shared builder turning a payload into `{promptSuffix, env, meta}` for relay and local paths, so attacker-controlled text reaches the LLM as framed data (R4, R5, R6, D6).
What changes at a high level: New `src/utils/webhook-payload.ts`. Prompt suffix carries the "untrusted data, not instructions" preamble plus a json fence longer than any backtick run in the payload. Serialized JSON capped at 64KB at a char boundary with the truncation wrapper marker; `CRONTICK_EVENT` holds the same capped text. Env sets `CRONTICK_TRIGGER=webhook`, `CRONTICK_EVENT`, `CRONTICK_EVENT_SOURCE`, `CRONTICK_EVENT_ID`. Relay payload is `{headers (allowlist only), body, query?, receivedAt}`; proxy noise is dropped. Also builds the `trigger_json` content SP05 stores.
Done when: Tests cover backtick-run payloads, >64KB truncation with marker, allowlist filtering, env presence at top priority via SP05 `buildRunEnv`.

## Task 3 — Hand-written SSE client
What it is / what it means: The transport, since Node 22 has no global EventSource and no new dependency is allowed (D2, D8).
What changes at a high level: New pure `src/daemon/sse.ts` with `connectSse(url, {onEvent, signal, fetch})`: reads the body stream, splits on blank lines, handles `id/event/data` (multi-line data joined, comments ignored), errors on non-200 or non-event-stream content type. No `Last-Event-ID` and no replay.
Done when: Unit tests with an in-memory stream cover mid-line and mid-UTF-8 chunk splits, multi-line data, comments, `ready`/`ping` surfaced for the caller to ignore, and both error cases.

## Task 4 — Relay manager, `syncRelays` lifecycle, in-memory status
What it is / what it means: One outbound connection per distinct relay URL, refcounted, feeding the SP05 dispatcher (D1, D4, D8; Architecture Relay manager and Lifecycle).
What changes at a high level: New `src/daemon/relay.ts` with `subscribe`, `unsubscribe`, `status`, `stop`. `message` events are JSON-parsed (bad JSON dropped) and dispatched per subscribed job as a `webhook` trigger. Reconnect uses exponential backoff 1s to 60s with full jitter, reset after 60s connected; a 90s idle watchdog aborts and reconnects. Wire one idempotent `syncRelays(jobs)` into daemon startup, job create/update/delete/enable/disable and reload; a changed `relay` re-subscribes. Dispatcher re-checks kind and enabled at event time. Startup records no missed runs for webhook jobs. Status is in memory only.
Done when: Fake fetch/timer tests show one connection for two same-URL jobs, unsubscribe on disable/delete/update, backoff and watchdog, nothing processed after `stop()`, stale event for an edited or disabled job does not fire.

## Task 5 — Event guards: HMAC, dedupe, burst limit
What it is / what it means: Relay-path-only protections bounding cost and spoofing (R7, R8, R9, D7). Local triggers skip all three.
What changes at a high level: If `secret` is set, require `x-hub-signature-256` = sha256 HMAC of `JSON.stringify(body)` via `timingSafeEqual`; mismatch or absent drops with warn log and counter. Per-job LRU dedupe on delivery id (fallbacks per PRD). Per-job token bucket, default 10/min as a constant in `src/constants/`; excess dropped and recorded as one `skipped` run per minute with `RATE_LIMITED (n dropped)`; overlap policy then applies.
Done when: Valid/invalid/absent HMAC, repeated-id drop, and the 11th-event skipped run are tested. Verify HMAC over smee with a real GitHub delivery (owner-configured webhook); if it fails, ship without `--webhook-secret` (remove flag/field from the surfaces) and record raw-body relay in futures. Verify and tune the 10/min burst and 256-entry/10-min dedupe values during implementation.

## Task 6 — Trigger surfaces: client, CLI, MCP, API, surface parity
What it is / what it means: Local firing of webhook jobs through the same dispatch path (R3, R13, D5, D7).
What changes at a high level: Client `triggerJob(id, {payload?})` via `resolveJobRef`; CLI `jobs trigger <job> [--payload <json>|@file|->]`; MCP `trigger_job`; `POST /api/jobs/:id/trigger` with body `{payload?}`, covered by SP03's guard. Webhook-kind only, else `NOT_WEBHOOK_JOB` (hint run-now); disabled gives `JOB_DISABLED`; non-JSON payload gives `INVALID_PAYLOAD`. Returns `{runId}`. Add `SURFACE_CAPABILITIES` entries for webhook schedule kind and trigger. Shims stay thin.
Done when: All surfaces return `{runId}` or the right error; cross-origin POST rejected by the guard; `surface-drift` green.

## Task 7 — Redaction and export/import stripping
What it is / what it means: The relay URL is a bearer secret, so it and `secret` must not leak (R11; RESOLVED storage and export decisions).
What changes at a high level: Add a separate `redactForLlm` branch for relay channel and secret (`redactValue` core unchanged). Redact in logs, `jobs list`, MCP output, `doctor`, exports (`https://smee.io/Uk…Sd`, `secret: set`). Show full values only in `jobs get` (CLI), dashboard copy button, and `jobs new --relay auto` output. Export/import strips `relay` and `secret` by default unless `--include-secrets`. Storage stays plaintext in the 0600 jobs file; no keychain.
Done when: Tests show redaction on each surface listed, full value only in the three allowed places, export strips by default and keeps with the flag.

## Task 8 — Status and trigger rendering: `jobs get`, `runs get`, `doctor`
What it is / what it means: Make relay health and trigger provenance visible (R10, R12).
What changes at a high level: `getRelayStatus()` (per relay: redacted URL, state, lastEventAt, lastError, eventCount) exposed through the daemon and shown in `jobs get` and `doctor` (`relay:` check, WARN on persistent error). `runs get` renders "Triggered by webhook (relay|local) at <time>, delivery <id>" and the payload from SP05's `trigger_json`; SP06 owns this rendering.
Done when: Status appears in `jobs get` and `doctor` with WARN on error; `runs get` shows source, delivery id and payload.

## Task 9 — Dashboard Webhook kind, Create channel, Trigger now
What it is / what it means: The editor and drawer support for the new kind (Architecture Dashboard).
What changes at a high level: Add `SCHEDULE_KINDS.webhook` (relay URL text, secret password input), `POST /api/relay/new` doing the smee redirect server-side (guarded by SP03), "Create channel" button, read-only relay URL with Copy and status dot in the drawer, "Trigger now" with payload textarea, a Webhook entry in the "How to schedule" footer, and the run-log modal payload view with collapsible JSON.
Done when: Webhook jobs can be created, edited, copied, triggered from the dashboard; asset-level tests pass.

## Task 10 — Tests, docs, ADR 0036, changeset
What it is / what it means: Close out per AGENTS.md and the PRD acceptance criteria.
What changes at a high level: Fill test gaps listed in the acceptance criteria. Update `docs/concepts/scheduling.md`, add `docs/concepts/webhooks.md` (GitHub setup, security warnings about restricted engine permissions, daemon-down loss, self-hosting smee), `docs/specs/001/002`, `docs/reference/{cli,mcp,library,api}`. Add ADR 0036 (outbound relay vs loopback-only) and a changeset. Record any HMAC fallback in futures.
Done when: `npm run validate` passes with `surface-drift` green; docs, ADR and changeset exist.

## Manual steps
Owner: add the GitHub webhook (Payload URL = relay URL, content type `application/json`, same secret if used), redeliver a ping and confirm a run appears (this is also the HMAC verify in Task 5); treat the relay URL as a secret and rotate via `jobs update <job> --relay auto`; optionally self-host smee. Deferred (out of scope): non-GitHub providers' HMAC, event filtering, replay, multi-relay per job.
