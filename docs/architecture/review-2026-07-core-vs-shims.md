# Core vs shims architecture review — round 2 (2026-07-25)

## Verdict
FAIL

## Findings
| Severity | File:line | Rule | Required fix |
|---|---|---|---|
| P0 | src\cli\index.ts:353 | Rule 2 — No proprietary/business logic in a shim | `crontick uninstall --purge` performs product state mutation directly in the CLI: it resolves the data directory, checks the live daemon pid, prompts, and deletes all crontick state with `rmSync` (`src\cli\index.ts:353-370`). Move purge/uninstall behavior into a shared core helper or `CrontickClient` method that owns the daemon-running guard and deletion semantics; keep the CLI to flag parsing, confirmation text, invoking that helper, and rendering the result. |

## Drift matrix
| Capability | Client/core | CLI | MCP | Status |
|---|---|---|---|---|
| create/update/import job | `src\client.ts:80` `createJob`, `src\client.ts:97` `updateJob`, `src\client.ts:146` `importJobs`; core builders in `src\job-input.ts:118` and `src\job-input.ts:146` | `src\cli\index.ts:180` `new`, `src\cli\index.ts:190` `update`, `src\cli\index.ts:297` `import` | `src\mcp\index.ts:94` `crontick_job_create`, `src\mcp\index.ts:124` `crontick_job_update`, `src\mcp\index.ts:324` `crontick_import` | present |
| job read/enable/disable/delete | `src\client.ts:89` `listJobs`, `src\client.ts:93` `getJob`, `src\client.ts:103` `deleteJob`, `src\client.ts:107`/`src\client.ts:111` enable/disable | `src\cli\index.ts:203` `list`, `src\cli\index.ts:207` `get`, `src\cli\index.ts:211`/`src\cli\index.ts:215` enable/disable, `src\cli\index.ts:219` delete | `src\mcp\index.ts:106` list, `src\mcp\index.ts:115` get, `src\mcp\index.ts:140` delete, `src\mcp\index.ts:150`/`src\mcp\index.ts:159` enable/disable | present |
| runs and logs | `src\client.ts:115` `runNow`, `src\client.ts:119` `cancelRun`, `src\client.ts:123` `getRun`, `src\client.ts:127` `listRuns`, `src\client.ts:136` `getLogs({ lines })` | `src\cli\index.ts:223` `run-now`, `src\cli\index.ts:227` `cancel-run`, `src\cli\index.ts:231` `runs`, `src\cli\index.ts:246` `logs --tail/--lines` | `src\mcp\index.ts:168` run now, `src\mcp\index.ts:178` cancel, `src\mcp\index.ts:189` list runs, `src\mcp\index.ts:202` get run, `src\mcp\index.ts:211` logs tail | present |
| schedules | `src\client.ts:151` `validateSchedule`, `src\client.ts:155` `previewSchedule` | `src\cli\index.ts:261` `schedule`, `src\cli\index.ts:262` validate, `src\cli\index.ts:265` preview | `src\mcp\index.ts:226` validate, `src\mcp\index.ts:238` preview | present |
| stats | `src\client.ts:163` `statsSummary`, `src\client.ts:167` `statsJob` | `src\cli\index.ts:273` `stats`, `src\cli\index.ts:274` summary, `src\cli\index.ts:277` job | `src\mcp\index.ts:254` summary, `src\mcp\index.ts:264` job | present |
| daemon status/reload/restart | `src\client.ts:182` `daemonRestart`, `src\client.ts:188` `daemonReload`, `src\client.ts:192` `daemonStatus`; shared lifecycle in `src\daemon\lifecycle.ts:30`/`src\daemon\lifecycle.ts:47`/`src\daemon\lifecycle.ts:70` | `src\cli\index.ts:334` status, `src\cli\index.ts:337` reload, `src\cli\index.ts:340` restart | `src\mcp\index.ts:275` status, `src\mcp\index.ts:292` reload, `src\mcp\index.ts:302` restart | present |
| daemon start/stop | `src\client.ts:171` `daemonStart`, `src\client.ts:177` `daemonStop`; shared lifecycle in `src\daemon\lifecycle.ts:30` and `src\daemon\lifecycle.ts:47` | `src\cli\index.ts:321` start, `src\cli\index.ts:331` stop | not applicable; MCP exposes restart/status/reload only | present / intentionally not applicable |
| doctor | `src\client.ts:196` `doctor`, shared checks in `src\doctor.ts:24` | `src\cli\index.ts:306` `doctor` renders client result | `src\mcp\index.ts:350` `crontick_doctor` returns client result | present |
| dashboard | `src\client.ts:205` `dashboardUrl` | `src\cli\index.ts:381` `dashboard` opens/renders URL | `src\mcp\index.ts:336` `crontick_dashboard_open` returns URL | present |
| job JSON schema | `src\schema-json.ts:4` `jobJsonSchema`; `src\client.ts:211` client wrapper | not applicable | `src\mcp\index.ts:496` schema resource calls `src\mcp\index.ts:502` client schema | present |
| uninstall/purge all data | no shared core/client operation owns purge semantics | `src\cli\index.ts:347` `uninstall`; direct daemon-running guard and `rmSync` at `src\cli\index.ts:353-370` | not applicable | drifted: state mutation lives in a shim |

## Round-1 verification
| Finding # | Fixed? | Evidence |
|---|---|---|
| 1. MCP bypassed the client | Yes | MCP now constructs a `CrontickClient` in `src\mcp\index.ts:29-36`; job create delegates to `mcpClient().createJob` at `src\mcp\index.ts:103`, and other tools follow the same client-call pattern. Search found no `callDaemon`/direct `/api/` transport wrapper in `src\mcp\index.ts`. |
| 2. Missing client `cancelRun`/`stats`/`doctor` | Yes | `cancelRun` is present at `src\client.ts:119`, `statsSummary` at `src\client.ts:163`, `statsJob` at `src\client.ts:167`, and `doctor` at `src\client.ts:196`. |
| 3. CLI `new` owned validation/normalization | Yes | CLI `new` now collects flags and calls `client().createJobFromCliOptions(...)` at `src\cli\index.ts:180-184`; normalization/default construction lives in `src\client.ts:85-86` and `src\job-input.ts:118-143`. |
| 4. Doctor duplicated CLI/MCP | Yes | Structured checks are in `src\doctor.ts:24-97`; CLI calls `client(false).doctor(...)` at `src\cli\index.ts:306-308`, and MCP calls `mcpClient(false).doctor(...)` at `src\mcp\index.ts:350-357`. |
| 5. Daemon lifecycle duplicated / CLI-only | Yes | Shared lifecycle helpers exist at `src\daemon\lifecycle.ts:30` (`startDaemon`), `src\daemon\lifecycle.ts:47` (`stopDaemon`), and `src\daemon\lifecycle.ts:70` (`restartDaemon`); client exposes them at `src\client.ts:171-183`, CLI uses client methods at `src\cli\index.ts:321-342`, and MCP restart uses the client at `src\mcp\index.ts:302-309`. |
| 6. MCP schemas duplicated core and omitted `promptFile` | Yes | MCP imports shared schemas at `src\mcp\index.ts:11-12` and spreads `JobCreateInputSchema.shape` at `src\mcp\index.ts:99-101`; that shared schema includes `promptFile` in `src\job-input.ts:19-22`. MCP prompt-file coverage exists at `tests\mcp.test.ts:226-241`. |
| 7. JSON schema generation lived in MCP | Yes | Schema generation is now in shared `src\schema-json.ts:4-8`; client exposes `jobJsonSchema()` at `src\client.ts:211-213`, and MCP serves it through the client at `src\mcp\index.ts:496-503`. |
| 8. CLI parity gaps (update/runs/schedule/stats/cancel) | Yes | CLI has `update` at `src\cli\index.ts:190`, `cancel-run` at `src\cli\index.ts:227`, `runs` at `src\cli\index.ts:231-243`, `schedule` at `src\cli\index.ts:261-270`, and `stats` at `src\cli\index.ts:273-278`; drift tests assert table parity in `tests\surface-drift.test.ts:21-75`. |
| 9. Param/response drift for logs/status/schedule preview | Yes | Logs unify on `getLogs(runId,{ lines })` in `src\client.ts:136-140`, used by CLI at `src\cli\index.ts:246-257` and MCP at `src\mcp\index.ts:211-221`; daemon status uses `client.daemonStatus()` at `src\client.ts:192-194`, `src\cli\index.ts:334-335`, and `src\mcp\index.ts:275-285`; schedule preview defaults through `src\client.ts:155-160` and MCP calls that at `src\mcp\index.ts:238-249`. |
| 10. Public root leaked daemon internals | Yes | The package facade now exports client, job helpers/types, schemas, schema helper, and surface metadata only (`src\index.ts:1-35`); no daemon ensure/path/pid/port helpers are exported. |
| 11. Prompt validation duplicated | Yes | Shared prompt runtime validation is centralized in `src\prompt-runtime.ts:21-57`; `src\job-input.ts:200-208` and `src\schemas\job.ts:109-125` both call it. |

## Verification reviewed
- Commands inspected/run: `git --no-pager status --short`, `git --no-pager diff --stat`, `git --no-pager diff --name-only`, `git --no-pager diff origin/main...HEAD --stat`, `git --no-pager diff origin/main...HEAD --name-only`, CLI/MCP/client surface enumeration from `.github\skills\review-crontick\SKILL.md`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, and a targeted rerun of `npm test -- tests/runner.test.ts -t "script: executes inline script body"`.
- Relevant results: `npm run typecheck` passed (exit 0); `npm run lint` passed (exit 0); `npm run build` passed (exit 0) with existing tsup CJS `import.meta` warnings; full `npm test` failed (exit 1) because `tests\runner.test.ts > Runner > script: executes inline script body` timed out at 5000 ms; targeted rerun of that test passed (1 passed, 27 skipped).
