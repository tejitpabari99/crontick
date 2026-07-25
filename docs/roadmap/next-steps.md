# crontick next steps: AI-first cron roadmap

Branch analyzed: current prompt-jobs daemon lifecycle branch  
Date: 2026-07-25

## Current baseline

crontick now ships a local daemon, CLI, dashboard, programmatic client, and stdio MCP server from one npm package (`package.json:20-34`). Prompt jobs are first-class: persisted jobs can use `action.kind: "prompt"` with `engine`, raw `args`, `sessionId`, and `reuseSession`, and CLI creation supports `--prompt`, `--prompt-file`, `--engine`, session flags, and raw passthrough args. The runner is config-driven with `shell:false`, captures bounded transcripts for session reuse, and appends `--session-id` when present.

The public edge surfaces are already multi-modal:

- CLI: human/shell UX, including daemon lifecycle, job CRUD, logs, import/export, dashboard, and MCP launch (`docs\cli.md:19-38`).
- Programmatic client: `createClient()` / `CrontickClient` over daemon HTTP with shared ensure and normalization (`src\client.ts:20-188`).
- MCP: AI-native tool adapter plus a job-schema resource, backed by the shared client.
- Daemon HTTP API: loopback-only internal transport and dashboard backend (`src\daemon\api.ts:46-55`, `docs\architecture\api-vs-cli-analysis.md:50-59`).

For public release, keep the product message from the API-vs-CLI analysis: CLI for humans and scripts, MCP for AI hosts, and `createClient()` for Node/TypeScript embedders; do not advertise the loopback HTTP daemon as a stable integration contract (`docs\architecture\api-vs-cli-analysis.md:139-195`).

## 1. Carried-over / deferred hardening items

These are near-term hardening tasks before larger AI-first feature work. `multi-persona-review.v1.model.md` is the only review artifact that contains explicit DEFER decisions; no separate rubber-duck artifact is present, so the source-observed gaps below are treated as rubber-duck/known-gap follow-ups.

| Priority | Item                                                                           | Problem                                                                                                                                                                                                                                                                                                                 | Proposed approach                                                                                                                                                                                                                                | Effort | Dependencies                                   |
| -------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -----: | ---------------------------------------------- |
| Done     | Dashboard is core-owned                                                        | Dashboard data aggregation now lives in `src\dashboard.ts`; CLI/MCP/client expose `dashboardStart`, `dashboardStatus`, `dashboardData`, and `dashboardStop`, and the browser UI renders `/api/dashboard`.                                                                                                                 | Keep the dashboard basic and read-only until result capture/config visibility justify richer UI.                                                                                                                                                  | Done | —                                              |

Completed hardening items are marked Done or removed from this table: daemon demand-start docs, the single `startDaemon`
option, core-generated per-job schema sidecars, CLI log-follow removal, deterministic prompt session
reuse behavior, and speculative model-limit field removal.

## 2. AI-first feature roadmap

### P0 — must-have for AI-first public release

| Feature                             | Problem                                                                                                                                                                                                                                                                                                           | Proposed approach                                                                                                                                                                                                                                                                                                  | Effort | Dependencies                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -----: | ---------------------------------------- |
| Configuration system                | Done: `.crontick\config.json` now owns `defaultEngine` and configurable prompt engine command/args/env through core, client, CLI, and MCP.                                                                                                                                | Keep the schema minimal until more runtime settings are genuinely needed.                                                                                                                                                                                                                                         | Done | —                                      |
| Pluggable engine registry           | Engine names are now dynamic and runner startup is config-driven, but richer capabilities are still absent.                                                                                                                                                                  | Later add prompt/session argument styles, session capture strategy, supported features, default timeout, and capability validation only when multiple real engines require them.                                                                                                                                    |      M | Config schema                           |
| Per-job engine/model/runtime config | Today per-job prompt controls are `engine`, raw `args`, `sessionId`, `reuseSession`, `cwd`, `envFile`, and `timeoutSec` (`src\schemas\job.ts:66-73`). Model choice, temperature, output mode, and tool policy are opaque raw args.                                                                                | Add optional model/runtime option fields only where the configured engine declares support. Keep raw `args` for escape hatches.                                                                                                                            |      M | Pluggable engine metadata                |
| Secrets-safe prompt inputs          | Docs warn that prompt text and args are persisted and visible in argv (`docs\security.md:31-33`), and the runner currently sends prompt text as command-line args (`src\daemon\runner.ts:254-258`). This is a release blocker for serious users.                                                                  | Add secret references (`secretRef`, `envSecretRef`, or template variables resolved from OS keychain/env files at run time), support stdin/file prompt delivery for engines that allow it, redact prompt/args from process logs, and add a `doctor security` check.                                                 |      L | Engine capability registry; threat model |
| Agent run result capture            | Logs exist as redacted stdout/stderr chunks (`src\daemon\store.ts:305-325`), but there is no structured result, summary, artifact list, or notification payload. AI cron needs answers, not just logs.                                                                                                            | Add `run_results` table or JSON column with summary, artifacts, citations, session id, token/cost stats, and notification state. Let engines emit structured JSON via a configured marker/file, with fallback LLM-generated summary from log tail.                                                                 |      L | Store migration; engine output contracts |
| Observability for prompt jobs       | Current health/stats expose counts and durations (`src\daemon\api.ts:72-95`, `src\daemon\api.ts:248-280`) but not engine/model/session/cost/retry reasons.                                                                                                                                                        | Add per-run engine/model/session metadata, attempt records, retry reason, stdout/stderr byte counts, token/cost fields, and dashboard/MCP resources for AI run traces.                                                                                                                                             |      M | Result capture; store migration          |
| Public API surface hardening        | `src\index.ts` now keeps the root export focused on client/core APIs, schemas, config, dashboard types, surface metadata, and logging helpers. The remaining 1.0 task is to document which of those exports are stable.                                                                                                       | Before 1.0, explicitly document stable exports and add semver tests/API extractor-style checks.                                                                                                                                      |      M | Client parity refactor                   |

### P1 — important AI-first differentiators

| Feature                             | Problem                                                                                                                                                                                                         | Proposed approach                                                                                                                                                                                                                                         | Effort | Dependencies                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | -------------------------------------------- |
| Prompt templating and variables     | Prompt files are creation-time sugar only and persisted as static text (`src\job-input.ts:134-166`, `docs\actions.md:64-65`). Scheduled prompts often need dates, repo paths, prior run status, or recent logs. | Add `action.promptTemplate` with variables like `{{now}}`, `{{date}}`, `{{job.id}}`, `{{lastRun.status}}`, `{{env.NAME}}`, `{{secret.NAME}}`, and bounded helpers for file snippets. Provide `crontick prompt render --job <id> --at <time>` for preview. |      M | Config, secrets design                       |
| Chaining/dependencies between jobs  | Current scheduler fires independent cron/interval/one-shot jobs (`src\daemon\scheduler.ts:51-67`). AI workflows often need "summarize after scrape" or "notify only if analysis finds risk".                    | Add dependency triggers: `afterJob`, `onSuccess`, `onFailure`, `onResultMatch`, and fan-in groups. Store dependency edges, prevent cycles, and surface graph in dashboard/MCP.                                                                            |      L | Result capture; scheduler/store migration    |
| Notifications and webhooks          | Users must poll logs/runs via CLI/MCP/dashboard (`docs\getting-started.md:59-65`). AI-first cron should proactively surface results.                                                                            | Add notification sinks: desktop notification, webhook, file, email/Teams via user-provided command, and MCP resource updates. Per-job policy controls success/failure/summary delivery.                                                                   |      M | Result summaries; secrets for webhook tokens |
| Session lifecycle management        | Users can set/capture a session id but cannot list, inspect, rename, expire, or rotate sessions (`src\schemas\job.ts:71-72`, `src\daemon\store.ts:138-153`).                                                    | Add `crontick sessions list                                                                                                                                                                                                                               |    get | expire                                       | attach | detach`, MCP tools/resources, per-engine session metadata, TTL, last-used timestamp, and explicit rotation. | M   | Engine registry session strategy |
| Cost and rate limits                | Prompt jobs have no cost/rate limiting yet, so multiple schedules can stampede an engine account.                                                                    | Add global and per-engine concurrency/rate limits and cost guardrails after structured engine accounting exists.                                                                |      M | Cost observability                          |
| Agent-aware retries/backoff         | Generic retry exists (`src\daemon\runner.ts:167-190`) but treats prompt engine failures like any other process.                                                                                                 | Add retry classifiers for rate limit, auth, network, tool approval, and deterministic prompt errors. Support exponential backoff/jitter and max wall-clock per run.                                                                                       |      M | Observability/error taxonomy                 |
| AI-first dashboard and MCP workflows | Dashboard is now core-owned and basic/read-only, but it does not yet show prompt-specific result summaries, sessions, or repair workflows. MCP currently stays tool-first; no bundled prompt templates ship. | Add rendered prompt preview, result cards, session views, and only then consider MCP prompt templates such as `create-scheduled-prompt`, `summarize-last-run`, and `repair-failed-agent-job`. |      M | Config + prompt template + results           |

### P2 — later expansion

| Feature                                  | Problem                                                                          | Proposed approach                                                                                                                    | Effort | Dependencies                      |
| ---------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -----: | --------------------------------- |
| Engine plugin packages                   | Built-in engine registry may grow too large.                                     | Support npm-installed engine adapters discovered by config, with signed/trusted adapter metadata.                                    |      L | Stable adapter interface          |
| Approval and policy workflows            | Scheduled agents may run powerful tools without a human present.                 | Add per-job policy: dry-run first, require approval for mutations, restricted tool sets, allowed directories, and emergency disable. |      L | Engine/tool policy model          |
| Shared/team schedules                    | Current design is local-user only (`docs\security.md:3-6`).                      | Allow exportable project schedules with user-local secrets/config overlays. Keep daemon local.                                       |      M | Config precedence and secret refs |
| Calendar windows and maintenance periods | Cron alone cannot easily express "business days except holidays" or quiet hours. | Add schedule constraints/blackout windows layered on existing Croner schedules.                                                      |      M | Config/timezone policy            |

## 3. Configurability and public-release plan

### Goals

- Keep existing behavior unchanged when no config exists.
- Make AI defaults explicit and discoverable.
- Avoid making the internal daemon HTTP API the configuration contract.
- Keep persisted job JSON portable: job fields override config, and exports should be understandable without hidden global state where possible.

### Files and precedence

Recommended read precedence, highest first:

1. Per-command CLI flags and explicit client options.
2. Per-job persisted settings (`action.engine`, `action.args`, `action.cwd`, `action.timeoutSec`, `retry`).
3. Environment variables for bootstrapping and automation:
   - Existing: `CRONTICK_HOME`, `CRONTICK_DAEMON_URL`, `CRONTICK_DAEMON_BINARY`, `CRONTICK_MCP_START_DAEMON` (`src\paths.ts:5-13`, `src\daemon\ensure.ts:40-60`, `src\daemon\ensure.ts:256-260`, `src\mcp\index.ts:27-35`).
   - New: `CRONTICK_CONFIG`, `CRONTICK_DEFAULT_ENGINE`, `CRONTICK_ENGINE_<NAME>_COMMAND`, `CRONTICK_TELEMETRY`, `CRONTICK_LOG_LEVEL`.
4. Project config, discovered from the CLI/client working directory upward:
   - `.crontick\config.json` or `crontick.config.json`.
   - Project config should influence job creation defaults and project-local examples, not daemon data-dir discovery after the daemon is already running.
5. User config:
   - Existing path helper points at `<dataDir>\config.json` (`src\paths.ts:28-30`). Keep this as the default user config path.
   - If `CRONTICK_HOME` changes, user config moves with the data dir.
6. Built-in defaults:
   - Default engine `copilot` for package/API compatibility.
   - Current retry/overlap defaults from `JobSchema` (`src\schemas\job.ts`).

Special case: `dataDir` cannot be reliably read from a config file inside the data dir. Keep `CRONTICK_HOME` as the authoritative bootstrap override, with a `crontick config path` command explaining the resolved locations.

### Config schema v1

Add `src\schemas\config.ts` plus a generated `src\schemas\config.schema.json`:

```jsonc
{
  "version": 1,
  "defaults": {
    "engine": "copilot",
    "timeoutSec": 1800,
    "overlap": "skip",
    "retry": { "max": 0, "backoffSec": 30 },
    "cwd": null,
    "timezone": null,
  },
  "engines": {
    "copilot": {
      "command": "copilot",
      "argsBeforePrompt": [],
      "promptArg": "--prompt=",
      "sessionArg": "--session-id=",
      "supportsStdinPrompt": false,
      "supportsTokenUsage": false,
      "defaultArgs": [],
    },
    "agency": {
      "command": "agency",
      "argsBeforePrompt": ["cp"],
      "promptArg": "--prompt=",
      "sessionArg": "--session-id=",
      "supportsStdinPrompt": false,
      "supportsTokenUsage": false,
      "defaultArgs": [],
    },
  },
  "daemon": {
    "startupTimeoutMs": 10000,
    "healthTimeoutMs": 2000,
    "requestTimeoutMs": 30000,
  },
  "runs": {
    "retentionDays": null,
    "maxLogBytesPerRun": null,
    "redaction": "default",
  },
  "limits": {
    "globalPromptConcurrency": 1,
    "perEngineConcurrency": {}
  },
  "telemetry": {
    "enabled": false,
    "level": "off",
  },
}
```

Validation rules:

- Unknown top-level keys should fail in `crontick config validate` but can be warned/ignored at runtime for forward compatibility until 1.0.
- Engine IDs should be kebab-case and cannot shadow action kinds.
- Configured commands must be argv commands, not shell strings, unless an engine explicitly opts into shell execution (not recommended).
- Secret values are not allowed inline in config; use `env`, `envFile`, or future secret refs.

### Command surface

Add `crontick config` subcommands:

| Command                                          | Purpose                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `crontick config path [--scope user              | project] [--json]`                                                                                                 | Show resolved user/project config paths, active file set, and data dir.      |
| `crontick config init [--scope user              | project] [--force]`                                                                                                | Write a minimal config with current defaults and comments in docs, not JSON. |
| `crontick config list [--effective] [--json]`    | Show raw or merged config.                                                                                         |
| `crontick config get <key> [--json]`             | Read one effective key.                                                                                            |
| `crontick config set <key> <value> [--scope user | project]`                                                                                                          | Update scalar values with schema validation.                                 |
| `crontick config unset <key> [--scope user       | project]`                                                                                                          | Remove an override.                                                          |
| `crontick config validate [path]`                | Validate a config file and print actionable errors.                                                                |
| `crontick config doctor`                         | Check engine commands, prompt delivery capability, telemetry setting, data-dir writability, and security warnings. |

MCP should stay tool-first for config (`crontick_config_get`, `crontick_config_validate`, and the mutation tools) so the config surface remains aligned with the client and CLI.

### Per-job override model

- Creation-time defaults: CLI/client/MCP job creation fills omitted fields from effective config, then persists explicit normalized job JSON. This keeps exports/backups reproducible.
- Runtime defaults: engine command paths, rate limits, redaction policy, telemetry, and retention are evaluated at run time because they are machine-local operational settings.
- Per-job wins over global: `action.engine`, `action.args`, `action.timeoutSec`, `retry`, `cwd`, `env`, and `envFile` override defaults.
- Environment wins over config for daemon bootstrap and CI automation.

### Migration and back-compat

- Version config as `version: 1`; no config file means current behavior.
- Keep `PromptEngineSchema` compatibility for existing persisted `copilot`/`agency` jobs; if engine IDs become dynamic, migrate schema carefully so old exports import unchanged.
- Add `crontick config migrate` only after a second config version exists.
- Do not mutate existing jobs when config changes. Provide `crontick jobs apply-defaults --dry-run` later if users want bulk updates.
- Update `docs\architecture.md`, `docs\getting-started.md`, `docs\actions.md`, `docs\mcp.md`, and `src\skill\SKILL.md` when config ships.

## 4. Release readiness checklist

### Product/API contracts

- [ ] Declare semver policy for CLI flags/output, MCP tool schemas, the job schema resource, `createClient()` exports, and persisted job JSON (`docs\architecture\api-vs-cli-analysis.md:180-195`).
- [ ] Mark daemon HTTP endpoints, pid/port files, and low-level path helpers as internal/advanced unless intentionally stabilized.
- [ ] Add client/MCP parity tests so CLI/client/MCP create/update/import produce equivalent normalized jobs.
- [ ] Add and verify a generated job JSON schema before publishing schema docs.

### Documentation and examples

- [ ] Add AI-first quick starts: scheduled prompt with Agency, scheduled Copilot prompt, prompt-file job, explicit session job, `reuseSession` job, result/log inspection, and safe secret use.
- [x] Update dashboard docs for the core-owned dashboard lifecycle/data surface.
- [ ] Add an explicit "daemon is demand-started, not supervised" note.

### Security and privacy

- [ ] Threat-model prompt text in argv and persisted job JSON. This is the biggest AI-first blocker (`docs\security.md:31-33`).
- [ ] Add secrets-safe prompt/template mechanisms before encouraging production agent workflows.
- [ ] Review engine trust: configured engine binaries can execute arbitrary code as the local user. `doctor` should show resolved binary paths and warnings.
- [ ] Expand redaction beyond current common patterns (`src\daemon\runner.ts:21-52`) and test prompt/result redaction.
- [ ] Keep loopback-only daemon binding and tests (`src\daemon\api.ts:46-55`).
- [ ] Decide telemetry opt-in/off default, data collected, retention, and privacy policy before any telemetry implementation.

### Cross-platform readiness

- [ ] Validate all tests on Windows, Ubuntu, and macOS with Node 22 and 24; CI currently targets Windows/Ubuntu per the investigation (`.dev\...\investigate.v1.model.md:37`).
- [ ] Document shell availability: `script.shell: auto` maps to PowerShell on Windows and bash elsewhere (`src\daemon\runner.ts:457-470`), but users may not have `pwsh` or `bash` installed.
- [ ] Validate detached daemon behavior, signals, pid liveness, process killing, and path quoting on macOS/Linux. The product says Windows/macOS/Linux in README (`README.md:7-8`), but current recent work was Windows-centric.
- [ ] Replace or contain use of OS temp locations for script temp files (`src\daemon\runner.ts:219-225`) if stricter environments require data-dir-local temp storage.

### Packaging/publishing

- [ ] Keep npm package files limited to `dist`, plugin, bundled skill, README, and LICENSE (`package.json:36-42`).
- [ ] Run release preflight: `npm install`, `npm run typecheck`, `npm run build`, `npm test`, `verify-no-lockfile-tampering`, `verify-tarball` (`RELEASING.md:3-14`).
- [ ] Decide if public launch is `0.x` with clearly unstable API or `1.0` with stable client/MCP contracts.
- [ ] Confirm MIT license and DCO/sign-off guidance remain accurate (`LICENSE`, `CONTRIBUTING.md:5-14`).
- [ ] Update plugin metadata: `plugin\plugin.json` still describes script-focused scheduling and has a stale homepage owner (`plugin\plugin.json:1-17`).

## 5. Sequenced milestones

### M1 — Hardening and contract cleanup (P0)

Deliverables:

- Done: resolved daemon demand-start docs and the single `startDaemon` client option.
- Done: added verified generated job schema sidecars.
- Done: added missing client methods (`cancelRun`, stats, doctor helper) and reduced MCP/client drift.
- Done: removed CLI log-follow mode.
- Done: clarified prompt/session reuse behavior and removed speculative model-limit fields.

Exit criteria:

- Docs no longer imply removed startup-registration behavior.
- API-vs-CLI target layering is represented in code and docs.
- Targeted tests for schema, client parity, MCP parity, and docs guards pass.

### M2 — Configuration system (P0) — done for basics

Deliverables:

- Done: `ConfigSchema`, config loader, defaulting, mutation helpers, and config JSON schema export.
- Done: `crontick config init|get|set|unset|validate` plus engine list/add/update/remove.
- Done: matching client methods and MCP tools/resource.
- Done: effective config supplies prompt creation defaults and runtime engine command/args/env.
- Done: docs and examples for configuration.

Exit criteria:

- No-config behavior matches current release.
- Per-job fields override global defaults.
- `crontick config doctor` clearly shows resolved engines and paths.

### M3 — AI-first engine and safety foundation (P0/P1)

Deliverables:

- Pluggable engine registry for `copilot`, `agency`, and at least one documented custom engine template.
- Per-job model/engine options with validation by engine capability.
- Secrets-safe prompt/template inputs and safer prompt delivery options where engines support them.
- Agent-aware retries/backoff and global/per-engine prompt concurrency limits.
- Security docs and tests for argv/persistence/engine trust.

Exit criteria:

- Users can configure engine defaults and binary paths without editing jobs.
- Users have a documented way to keep secrets out of prompt text, args, and job JSON.
- Missing or untrusted engine binaries produce actionable doctor/runtime errors.

### M4 — Results, observability, and sessions (P1)

Deliverables:

- Structured run result storage: summaries, artifacts, session ids, attempts, token/cost fields when available.
- `crontick sessions` CLI and MCP/session resources.
- Notifications/webhooks/file sinks for run summaries and failures.
- Dashboard prompt-job creation, run result cards, session view, and log streaming polish.
- Prompt templating/render preview with safe variables.

Exit criteria:

- A scheduled prompt can produce a discoverable, summarized result without reading raw logs.
- Users can inspect/expire/reuse sessions explicitly.
- Dashboard/MCP expose the same AI-first run state as CLI/client.

### M5 — Public launch readiness (P0/P1)

Deliverables:

- Semver contract docs for CLI/client/MCP/job JSON.
- Full docs refresh, examples, troubleshooting, and awesome-mcp submission update.
- Cross-platform validation on Windows/macOS/Linux and Node 22/24.
- Security/privacy review, telemetry opt-in/off decision, package metadata cleanup, and release checklist completion.

Exit criteria:

- Release preflight is green.
- Public docs accurately describe AI-first cron, not just local script scheduling.
- Biggest blockers (secrets/argv leakage, engine trust, cross-platform daemon behavior) are either fixed or explicitly documented with safe defaults.
