---
status: done
summary: Evidence-backed answers to the owner's questions on raw-log source, usage/cost origin, the SessionEnd base64 hook, and totalTurns; replaces eval/base64 hook with a plain helper script and shortens displayed --settings.
date: 2026-10-01
---

# PRD: Engine observability Q&A (Phase 1)

Repo/branch: crontick, `.worktrees/claude-engine` / `users/tejitpabari/claude-engine`
Depends on: SP01 (shipped). Feeds: SP03 (stats), SP04 (display).
Owns (files): `src/engines/claude-adapter.ts`, `src/claude-completion-marker.ts`, `src/daemon/job-log-file.ts` (helper export only), `src/run-output.ts` (usage normalizer), `src/daemon/runner.ts:530` (command redaction).

## TL;DR
(1) Raw log = child stdout/stderr, stored in SQLite `run_logs`, mirrored to a **per-job** (not per-run) file; add a shared path helper. (2) Cost/usage are reported by Claude's final `result` event, not computed by crontick; keep raw `usageJson`, add display-only normalization. (3) The `Buffer.from` blob is the SessionEnd hook script, base64-wrapped for quoting; it is optional best-effort; replace with a plain helper script file. (4) Shorten `--settings` in stored/displayed commands.

## Answers

**Q1 Raw logs.** The runner spawns the engine and, per chunk, `RunLogWriter.append` writes to the store (`appendLog` -> `INSERT INTO run_logs`) and mirrors to a file (`runner.ts:186-210`, `store.ts:819`). `getLogs` reads `run_logs` (`store.ts:832-842`). The file is `<logging.dir ?? logsDir()>/<safeJobId>.log` (`job-log-file.ts:42-62`; `paths.ts:31` = `<dataDir>/logs`). Caveats [verified]: file is per **job**, appended across runs with no run delimiter; mirror is best-effort and disabled when `logging.fileEnabled=false` (`job-log-file.ts:53`); the store is the source of truth (`runner.ts:208`). No shared helper returns the path (grep `logFile|logPath` in client/api: none).
Contract to add (exported from `job-log-file.ts`):
```ts
resolveJobLogPath(jobId: string, env?): string | null  // absolute; null when fileEnabled=false
```
Reuses the existing `safeLogFileName` and config resolution. The daemon includes `logFile` (absolute, nullable) in the run/get payload. SP04 shows that path and does not render raw logs inline; because the file is per-job, SP04 labels it "job log (all runs)" and keeps `runs logs <runId>` for the exact per-run raw stream.

**Q2 Cost and usage.** Claude reports them; crontick computes nothing per run. `parseResult` scans the stdout tail backwards for the last `{"type":"result"}` line (`claude-adapter.ts:99-130`):

| Result field | Run column | Evidence |
|---|---|---|
| `total_cost_usd` | `cost_usd` / `costUsd` | adapter:111; store:579 |
| `num_turns` | `turns` | adapter:113; `store.ts:1107` |
| `usage` (whole object) | `usage_json` / `usageJson`, via `redactValue`+`JSON.stringify` | `runner.ts:807` |
| `session_id`, `subtype` | `sessionId`, `engineStatus` | adapter:110,115 |
| (not used) `duration_ms` | none: `durationMs` = crontick wall clock `now - run.startedAt` | `runner.ts:973` |

With retries, cost/turns are summed per attempt, and usage is deep-merged by adding numbers (`runner.ts:69-86,437-439`); so retried runs carry summed counters (non-numeric fields such as `service_tier` are overwritten, not summed).
`usageJson` is Claude's raw block: `input_tokens` (uncached input), `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, `output_tokens_details.thinking_tokens`, `server_tool_use`, `service_tier`, `inference_geo`, `speed`, plus `iterations[]`. Top-level counters (34 input) are the run total; `iterations[]` entries are per model-call breakdowns (iteration 0 shows 8), so they sum to or fall below the top level. Totals are what matter for display; ignore `iterations`. [Interpretation of Claude's schema from the sample; crontick does not parse it: grep `iterations` in src: 0 matches.]
Decision: keep raw (forward-compatible, other engines may differ). Add pure `normalizeUsage(usageJson): {inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, thinkingTokens?}` in `run-output.ts`, used only by display (CLI `runs get`/`stats job`, dashboard, `getOutput`); unknown or missing fields give `undefined`. No schema or storage change.

**Q3 The `Buffer.from` part.** It is the ephemeral SessionEnd hook (`claude-adapter.ts:25-43`), passed via `--settings` so the user's `~/.claude/settings.json` is untouched. The base64 decodes to a Node script: read hook JSON from stdin, extract `exit_status`/`session_id`, `mkdirSync` and write `{exitStatus, sessionId}` to `<dataDir>/runs/<runId>.claude-hook.json` (mode 0600), swallow all errors. Base64 was chosen so the Windows/POSIX shell never parses the marker path or script, and the JSON `--settings` value needs no nested escaping (adapter:22-24).
Consumption [verified: grep `readClaudeCompletionMarker`]: only (a) `store.ts:908` startup `reconcileOrphanRuns` and (b) `runner.ts:304` adopted-run poll; normal runs delete it (`runner.ts:435`) and use `parseResult`. It is best-effort (PRD-01 Decision 9, DEFERRED live validation) and has no unit-level proof it fires in `-p` mode.
Needed? Only for the "daemon was down when the run finished" gap. Options: keep; helper script; drop. **Decision: helper script.** At daemon start (and in `buildInvocation` fallback), write `<dataDir>/hooks/session-end.cjs` (fixed content, no embedded paths; marker path passed as argv), hook command = `"<process.execPath>" "<helper>" "<markerPath>"`. Rationale: removes `eval` and opacity, readable in `ps`/logs, quoting limited to two double-quoted paths (Windows-safe; POSIX uses single-quote escape as today). Dropping is rejected: it re-opens the restart gap, and no evidence shows the marker is unused. Security: eval input is generated, not user-controlled, but opaque; the helper file is written 0600 in a 0700 dir and does only the same fs writes. Fallback: if the helper cannot be written, omit `--settings` entirely (the hook is best-effort).
Edge: paths containing `"` are impossible on Windows; on POSIX runId is already validated `[A-Za-z0-9_-]` (`claude-completion-marker.ts:11`); dataDir with `"` or `$`: reject and omit hook rather than risk shell expansion.

**Command display.** `store.updateRun(..., command: redactText(...))` stores the full joined command including the `--settings` blob (`runner.ts:530`); `HOOK_EVAL` only cleans the output view (`run-output.ts:58`). Decision: store/display `--settings <session-end-hook>`; replace the value of `--settings` in the string at `runner.ts:530` and the diagnostic logs (`runner.ts:506,524,676`). The full hook is reproducible from the adapter and no longer needs to be stored; the raw spawn args are not user data. Also keep the prompt argument as-is (unchanged scope).

## Notes for SP03
`totalTurns` in `crontick stats job` is `runs.reduce(sum + (run.turns ?? 0))` over the last 100 runs of the job (`api.ts:350-363`, `limit: 100`; also `dashboard.ts:209`). Each run's `turns` is Claude's `num_turns` from the final result (agentic loop turns incl. tool-use turns, not user prompts), summed across retry attempts. So "6" = total Claude turns across up to 100 recent runs, and runs without a result (non-Claude, killed) contribute 0. Show it as "turns (last 100 runs)".

## Goals / Non-Goals
Goals: documented answers; path helper; usage normalizer; hook without eval; shorter command. Non-goals: dashboard rendering (SP04), stats UX (SP03), computing cost locally, changing the DB schema.

## Decisions
| # | Decision | Choice | Alternatives | Why |
|---|---|---|---|---|
| 1 | Log path | `resolveJobLogPath` helper + `logFile` field | Per-run files | No per-run file exists; avoids new storage |
| 2 | Cost source | Claude-reported `total_cost_usd` | Local pricing table | Stale-price risk; Claude is authoritative |
| 3 | usageJson | Raw stored, normalized for display | Normalize at store | Forward-compatible, no migration |
| 4 | Hook | Helper `.cjs`, argv marker path | Keep eval; drop | See Q3 |
| 5 | Command | Redact `--settings` value | Store full | Clutter; reproducible from code |

## Risks / Open Questions
- [RESOLVED: keep hook, remove eval] Live firing of SessionEnd in `-p` is still unvalidated; failure only degrades restart reconciliation.
- [RESOLVED: per-job file labelled as such] Run-level isolation stays in `run_logs`.
- [RESOLVED: ignore `iterations`] Totals suffice.
- [DEFERRED] Using Claude `duration_ms`/`duration_api_ms` for display.

## Acceptance Criteria
- `grep -rn "eval(" src/engines` returns 0; generated command contains no base64; the hook marker test passes through the helper on Linux and with a quoted Windows-style path.
- Helper is rewritten idempotently at startup; missing helper -> no `--settings`, run still succeeds.
- Stored `command` shows `--settings <session-end-hook>`; no JSON blob.
- `resolveJobLogPath` returns an absolute path, `null` when file logging is off; run get payload exposes `logFile`.
- `normalizeUsage` unit tests cover the sample object, missing thinking tokens, and non-object input; `usageJson` storage unchanged.
- `npm run validate` passes; docs/reference updated; changeset added.
