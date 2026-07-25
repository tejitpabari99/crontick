## Verdict
PASS

Final state has no remaining P0/P1/P2 architecture findings after the small fixes in this pass. Reviewed the current feature branch against merge-base `42051828a7f78266d22aac6a4727c9a8a1eb7138` (`origin/main`).

## Findings fixed in this pass
| Severity | File:line | Rule | Required fix |
|---|---|---|---|
| P0 | `src\mcp\index.ts:308`, `src\mcp\index.ts:318`, `src\surface.ts:27` | Rule 3 - No drift between surfaces | Added `crontick_daemon_start`/`crontick_daemon_stop` and surfaced daemon start/stop in the parity table. |
| P0 | `tests\surface-drift.test.ts:46`, `tests\surface-drift.test.ts:113` | Rule 3 - No drift between surfaces | Hardened surface-drift coverage so client methods are accounted for and MCP `crontick_*` tools exactly match the shared surface table. |
| P2 | `plugin\plugin.json:6`, `plugin\README.md:24` | Rule 8 - Keep it lightweight | Removed the stale plugin removal hook/file and docs after the removal surface was deleted. |
| P2 | `docs\architecture\fluff-audit.md:20`, `docs\roadmap\next-steps.md:29` | Rule 8 - Keep it lightweight | Removed stale references to removed flags/surfaces and speculative token-limit fields; fixed stale branch/doc drift. |

## Findings left for owner
| Severity | File:line | Rule | Required fix |
|---|---|---|---|
| - | - | - | No remaining architecture findings. |

## Surface lists

### CLI commands
`new`, `update`, `list`, `get`, `enable`, `disable`, `delete`, `run-now`, `cancel-run`, `runs list`, `runs get`, `logs`, `schedule validate`, `schedule preview`, `stats summary`, `stats job`, `config get`, `config set`, `config unset`, `config init`, `config validate`, `config engines`, `config engines add`, `config engines update`, `config engines remove`, `export`, `import`, `doctor`, `daemon start`, `daemon stop`, `daemon status`, `daemon reload`, `daemon restart`, `dashboard start`, `dashboard status`, `dashboard data`, `dashboard stop`, `mcp`.

### MCP tools
`crontick_job_create`, `crontick_job_list`, `crontick_job_get`, `crontick_job_update`, `crontick_job_delete`, `crontick_job_enable`, `crontick_job_disable`, `crontick_job_run_now`, `crontick_job_cancel_run`, `crontick_run_list`, `crontick_run_get`, `crontick_run_logs_tail`, `crontick_schedule_validate`, `crontick_schedule_preview`, `crontick_stats_summary`, `crontick_stats_job`, `crontick_daemon_start`, `crontick_daemon_stop`, `crontick_daemon_status`, `crontick_daemon_reload`, `crontick_daemon_restart`, `crontick_export`, `crontick_import`, `crontick_dashboard_start`, `crontick_dashboard_status`, `crontick_dashboard_data`, `crontick_dashboard_stop`, `crontick_doctor`, `crontick_config_get`, `crontick_config_set`, `crontick_config_unset`, `crontick_config_engine_list`, `crontick_config_engine_add`, `crontick_config_engine_update`, `crontick_config_engine_remove`, `crontick_config_init`, `crontick_config_validate`.

### Client methods
`ensure`, `health`, `createJob`, `createJobFromCliOptions`, `listJobs`, `getJob`, `updateJob`, `deleteJob`, `enableJob`, `disableJob`, `runNow`, `cancelRun`, `getRun`, `listRuns`, `getLogs`, `exportJobs`, `importJobs`, `validateSchedule`, `previewSchedule`, `statsSummary`, `statsJob`, `daemonStart`, `daemonStop`, `daemonRestart`, `daemonReload`, `daemonStatus`, `doctor`, `dashboardStart`, `dashboardStop`, `dashboardStatus`, `dashboardData`, `jobJsonSchema`, `getConfig`, `getConfigValue`, `setConfigValue`, `removeConfigValue`, `listEngines`, `addEngine`, `updateEngine`, `removeEngine`, `initConfig`, `validateConfig`, `drainNotices`, `isVerbose`.

## Drift matrix
| Capability | Client/core | CLI | MCP | Status |
|---|---|---|---|---|
| create job | `src\client.ts:120` `createJob` | `src\cli\index.ts:286` `new` | `src\mcp\index.ts:126` `crontick_job_create` | present |
| update job | `src\client.ts:137` `updateJob` | `src\cli\index.ts:298` `update` | `src\mcp\index.ts:156` `crontick_job_update` | present |
| list jobs | `src\client.ts:129` `listJobs` | `src\cli\index.ts:317` `list` | `src\mcp\index.ts:138` `crontick_job_list` | present |
| get job | `src\client.ts:133` `getJob` | `src\cli\index.ts:321` `get` | `src\mcp\index.ts:147` `crontick_job_get` | present |
| enable job | `src\client.ts:147` `enableJob` | `src\cli\index.ts:325` `enable` | `src\mcp\index.ts:182` `crontick_job_enable` | present |
| disable job | `src\client.ts:151` `disableJob` | `src\cli\index.ts:329` `disable` | `src\mcp\index.ts:191` `crontick_job_disable` | present |
| delete job | `src\client.ts:143` `deleteJob` | `src\cli\index.ts:333` `delete` | `src\mcp\index.ts:172` `crontick_job_delete` | present |
| run now | `src\client.ts:155` `runNow` | `src\cli\index.ts:337` `run-now` | `src\mcp\index.ts:200` `crontick_job_run_now` | present |
| cancel run | `src\client.ts:159` `cancelRun` | `src\cli\index.ts:341` `cancel-run` | `src\mcp\index.ts:210` `crontick_job_cancel_run` | present |
| list runs | `src\client.ts:167` `listRuns` | `src\cli\index.ts:346` `runs list` | `src\mcp\index.ts:221` `crontick_run_list` | present |
| get run | `src\client.ts:163` `getRun` | `src\cli\index.ts:356` `runs get` | `src\mcp\index.ts:234` `crontick_run_get` | present |
| logs | `src\client.ts:176` `getLogs` | `src\cli\index.ts:360` `logs` | `src\mcp\index.ts:243` `crontick_run_logs_tail` | present |
| schedule validate | `src\client.ts:191` `validateSchedule` | `src\cli\index.ts:375` `schedule validate` | `src\mcp\index.ts:258` `crontick_schedule_validate` | present |
| schedule preview | `src\client.ts:195` `previewSchedule` | `src\cli\index.ts:378` `schedule preview` | `src\mcp\index.ts:270` `crontick_schedule_preview` | present |
| stats summary | `src\client.ts:203` `statsSummary` | `src\cli\index.ts:387` `stats summary` | `src\mcp\index.ts:286` `crontick_stats_summary` | present |
| stats job | `src\client.ts:207` `statsJob` | `src\cli\index.ts:390` `stats job` | `src\mcp\index.ts:296` `crontick_stats_job` | present |
| config get | `src\client.ts:285` `getConfigValue` | `src\cli\index.ts:395` `config get` | `src\mcp\index.ts:446` `crontick_config_get` | present |
| config set | `src\client.ts:289` `setConfigValue` | `src\cli\index.ts:398` `config set` | `src\mcp\index.ts:455` `crontick_config_set` | present |
| config unset | `src\client.ts:293` `removeConfigValue` | `src\cli\index.ts:401` `config unset` | `src\mcp\index.ts:464` `crontick_config_unset` | present |
| config init | `src\client.ts:313` `initConfig` | `src\cli\index.ts:404` `config init` | `src\mcp\index.ts:509` `crontick_config_init` | present |
| config validate | `src\client.ts:317` `validateConfig` | `src\cli\index.ts:409` `config validate` | `src\mcp\index.ts:518` `crontick_config_validate` | present |
| engine list | `src\client.ts:297` `listEngines` | `src\cli\index.ts:417` `config engines` | `src\mcp\index.ts:473` `crontick_config_engine_list` | present |
| engine add | `src\client.ts:301` `addEngine` | `src\cli\index.ts:421` `config engines add` | `src\mcp\index.ts:482` `crontick_config_engine_add` | present |
| engine update | `src\client.ts:305` `updateEngine` | `src\cli\index.ts:428` `config engines update` | `src\mcp\index.ts:491` `crontick_config_engine_update` | present |
| engine remove | `src\client.ts:309` `removeEngine` | `src\cli\index.ts:435` `config engines remove` | `src\mcp\index.ts:500` `crontick_config_engine_remove` | present |
| export | `src\client.ts:182` `exportJobs` | `src\cli\index.ts:439` `export` | `src\mcp\index.ts:369` `crontick_export` | present |
| import | `src\client.ts:186` `importJobs` | `src\cli\index.ts:455` `import` | `src\mcp\index.ts:379` `crontick_import` | present |
| doctor | `src\client.ts:236` `doctor` | `src\cli\index.ts:464` `doctor` | `src\mcp\index.ts:434` `crontick_doctor` | present |
| daemon start | `src\client.ts:211` `daemonStart` | `src\cli\index.ts:479` `daemon start` | `src\mcp\index.ts:307` `crontick_daemon_start` | present |
| daemon stop | `src\client.ts:217` `daemonStop` | `src\cli\index.ts:489` `daemon stop` | `src\mcp\index.ts:317` `crontick_daemon_stop` | present |
| daemon status | `src\client.ts:232` `daemonStatus` | `src\cli\index.ts:492` `daemon status` | `src\mcp\index.ts:327` `crontick_daemon_status` | present |
| daemon reload | `src\client.ts:228` `daemonReload` | `src\cli\index.ts:495` `daemon reload` | `src\mcp\index.ts:347` `crontick_daemon_reload` | present |
| daemon restart | `src\client.ts:222` `daemonRestart` | `src\cli\index.ts:498` `daemon restart` | `src\mcp\index.ts:357` `crontick_daemon_restart` | present |
| dashboard start | `src\client.ts:245` `dashboardStart` | `src\cli\index.ts:506` `dashboard start` | `src\mcp\index.ts:391` `crontick_dashboard_start` | present |
| dashboard status | `src\client.ts:255` `dashboardStatus` | `src\cli\index.ts:517` `dashboard status` | `src\mcp\index.ts:401` `crontick_dashboard_status` | present |
| dashboard data | `src\client.ts:266` `dashboardData` | `src\cli\index.ts:524` `dashboard data` | `src\mcp\index.ts:411` `crontick_dashboard_data` | present |
| dashboard stop | `src\client.ts:251` `dashboardStop` | `src\cli\index.ts:538` `dashboard stop` | `src\mcp\index.ts:424` `crontick_dashboard_stop` | present |
| MCP launcher | not applicable | `src\cli\index.ts:546` `mcp` | not applicable | present (CLI-only launcher) |
| job JSON schema resource | `src\client.ts:277` `jobJsonSchema` / core `src\schema-json.ts` | not applicable | `src\mcp\index.ts:510` `crontick://schemas/job` | present |

## Verification reviewed
- Drift scope: `git merge-base HEAD origin/main` = `42051828a7f78266d22aac6a4727c9a8a1eb7138`; reviewed `git diff --stat/name-status` for branch diff.
- Surface checks: enumerated CLI commands, MCP tools, client methods; `tests\surface-drift.test.ts` now checks client accounting and exact MCP tool parity.
- Architecture sweeps: no core `console.*`, `process.exit`, chalk, Commander, or MCP SDK imports outside CLI/MCP/daemon entrypoint; core generates job JSON schema sidecars via `src\daemon\store.ts:142`; runner resolves prompt argv through config via `src\daemon\runner.ts:255` and `src\config.ts:177`.
- Docs sweeps: stale removed-plugin hook references, removed follow/line flags, legacy start-flag and token-limit field references are absent from `README.md`, `docs\**`, and `plugin\**`; relative markdown links resolve.
- Dependency sweep: package deps are referenced by source/scripts/tests; no unused package dependency found.
- Verification run 1: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` all passed; tests `38 passed`, `316 passed`.
- Verification run 2: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` all passed; tests `38 passed`, `316 passed`.
- CLI help: `node dist\cli\index.js --help`, `logs --help`, `daemon --help`, and `mcp --help` rendered successfully.
