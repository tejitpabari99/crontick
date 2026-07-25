# API vs CLI architecture analysis

## Decision

Keep both the command-line interface and the programmatic API for public release, but treat the programmatic client/core as the source of truth. The CLI and MCP server should be thin adapters over that client/core. The loopback HTTP daemon API should remain an internal transport between processes, not the documented public integration contract.

If crontick were forced to keep only one product surface, the programmatic client/core is the more important architectural primitive because it can power the CLI, MCP, tests, extensions, and future UI/agent integrations. As a product, however, crontick needs both: humans need a terminal UX, while embedders and AI-first integrations need a typed, non-shell API.

## Current architecture

```mermaid
flowchart TD
  Human[Human at terminal] --> CLI[src\cli\index.ts\nCommander CLI]
  Shell[Shell scripts / package scripts] --> CLI
  NodeProgram[Node or TypeScript program] --> Client[src\client.ts\nCrontickClient]
  MCPHost[AI agent / MCP host] --> MCP[src\mcp\index.ts\nstdio MCP server]
  Skill[Bundled skill / plugin] --> MCP
  Skill --> CLI

  CLI -->|parse args + render| Client
  CLI -->|mcp launcher, browser open, import/export files| CLILocal[CLI-local UX helpers]
  MCP -->|tool schemas + job schema resource| Client
  Client --> Ensure[src\daemon\ensure.ts]
  Client --> Lifecycle[src\daemon\lifecycle.ts]
  Client --> Doctor[src\doctor.ts]
  Client -->|fetch JSON| HTTP

  HTTP --> Api[src\daemon\api.ts\ncreateApiServer]
  Api --> Store[src\daemon\store.ts\nJob JSON + SQLite]
  Api --> Scheduler[src\daemon\scheduler.ts]
  Api --> Runner[src\daemon\runner.ts]
  Daemon[src\daemon\index.ts\ndaemon process] --> Api
  Scheduler --> Runner
  Runner --> Child[script / exec / prompt child process]
```

Current real layering:

- `package.json` ships three binaries (`crontick`, `crontick-daemon`, `crontick-mcp`) and a package root export for `createClient()` / `CrontickClient` (`package.json:20-34`).
- `src\index.ts` exports the client, daemon ensure helpers, schemas, paths, and types (`src\index.ts:1-20`). This already makes more than the CLI a public package surface.
- The CLI imports `createClient()` and core job builders. Its handlers parse flags, call client/core methods, and render output.
- Daemon-backed CLI commands now call client methods for create/update/list/get, enable/disable/delete, run/cancel/run inspection/logs, schedule validation/preview, stats, doctor, daemon lifecycle, import/export, and dashboard lifecycle/data.
- `new` and `update` delegate schedule/action construction, prompt-file normalization, prompt/session validation, and job validation to shared core helpers in `src\job-input.ts`.
- The client is the daemon-aware source of truth: it normalizes create/update/import inputs, owns all daemon endpoint calls, ensures or controls daemon lifecycle, runs doctor checks, serves schema generation, and maps daemon errors to `CrontickError`.
- The daemon HTTP API is the actual process boundary. `src\daemon\api.ts` accepts loopback-only requests, validates persisted job JSON, then calls Store/Scheduler/Runner (`src\daemon\api.ts:46-55`, `98-170`, `223-317`).
- The daemon process owns durable state and execution: it opens the store, loads jobs, schedules enabled jobs, listens on an ephemeral `127.0.0.1` port, and writes the port file (`src\daemon\index.ts:98-154`).
- The MCP server uses `CrontickClient` for daemon-backed tools, doctor checks, dashboard lifecycle/data, lifecycle operations, and shared job schema generation. It keeps only MCP-specific tool schemas, the job schema resource, redaction, and JSON formatting.

## HTTP daemon API as a third surface

The HTTP API exists, but it should be treated as an internal transport rather than the public API:

- It binds only to loopback and rejects non-loopback sockets (`src\daemon\api.ts:46-55`).
- It listens on a random port discovered via the port file (`src\daemon\index.ts:148-154`).
- It has no remote auth model; the README explicitly defines the trust boundary as the local user session (`README.md:38-42`).
- It accepts normalized persisted job JSON only; caller-side sugar such as `promptFile` belongs in the CLI/client normalizer, not in the daemon (see the design model artifact).

This makes the client more, not less, important. The client hides daemon start/probe mechanics, transport errors, endpoint paths, JSON parsing, and prompt-file normalization behind a typed API. Public consumers should not be told to read pid/port files or call ephemeral loopback endpoints directly.

## Consumer to surface matrix

| Consumer | Primary surface | Secondary surface | Needs | Why this surface fits |
|---|---|---|---|---|
| Human at terminal | CLI | Dashboard, MCP via host config | Discover commands, create jobs quickly, inspect runs/logs, explicit daemon lifecycle, copy/paste examples | CLI is the lowest-friction public UX and works after `npm install -g crontick`. It can present friendly errors and table/JSON output. |
| Shell scripts / CI / dotfiles | CLI with `--json` | Programmatic API for richer scripts | Stable process exit codes, JSON output, no TypeScript setup | CLI is scriptable and language-agnostic, but should stay thin to avoid divergent behavior. |
| Node/TypeScript embedding app | Programmatic API (`createClient`) | None, unless spawning MCP for AI hosts | Typed methods, exceptions, no shell quoting, daemon on-demand, direct objects | The client avoids fragile stdout parsing and can evolve with TypeScript types and semver. |
| AI agent / MCP client | MCP tools | CLI fallback when MCP unavailable | Tool schemas, confirmable destructive actions, schedule preview, logs, and job schema discovery | MCP is the native AI surface. It exposes intent-specific tools rather than asking an LLM to synthesize shell commands. |
| Bundled skill / Copilot plugin | MCP first; CLI fallback/install/doctor | Programmatic API if future extension code embeds crontick | Install verification, teach LLM workflow, validate/preview before creation | `plugin\install.mjs` uses `crontick doctor`; `src\skill\SKILL.md` prefers MCP tools and uses CLI examples/fallback (`plugin\install.mjs:73-74`, `src\skill\SKILL.md:95-108`, `254-286`). |
| Daemon process | Internal HTTP handlers + Store/Scheduler/Runner | None | Local process boundary, durable state, scheduling, run execution | The daemon should not call the CLI or public client; it owns the authoritative state machine. |
| Dashboard/static UI | Core dashboard model via daemon endpoint | Public client dashboardStart/status/data/stop | Read the shared dashboard model from the local daemon | The dashboard is served by the daemon, but data aggregation lives in src\dashboard.ts and is exposed consistently through client, CLI, and MCP. |

## Option analysis

### CLI-only

Benefits:

- Smallest public mental model: install one binary and run commands.
- Easy for humans, demos, README examples, shell scripts, and plugin install checks.
- Avoids semver promises for TypeScript classes and package exports.

Disadvantages:

- Bad embedding story: Node/TS callers must spawn a process, quote arguments, parse stdout/stderr, and handle platform differences.
- AI integrations become brittle if they must synthesize shell commands instead of using typed tool schemas.
- Long prompt text, prompt files, engine args, and session controls are exactly where shell quoting is most fragile.
- Testing only through CLI is slower and less precise than testing a client/core directly.
- A CLI cannot cleanly power MCP without either shelling out or duplicating HTTP logic.

CLI-only would make crontick feel like a utility, not a reusable scheduling platform.

### API-only

Benefits:

- One typed source of truth for daemon ensure, validation, job creation, and errors.
- Best surface for embedders, tests, future GUIs, and extension code.
- Avoids command parsing/output formatting drift.

Disadvantages:

- Poor first-run experience for a public cron tool; users expect `crontick new`, `crontick list`, and `crontick logs`.
- Shell users, docs, plugin install scripts, and non-Node automation lose the simplest integration path.
- Daemon lifecycle and doctor checks become awkward without a binary.
- Public release discoverability suffers: npm packages with only library APIs are harder to demo for local automation.

API-only is architecturally clean but product-poor for a local cron daemon.

### Both CLI and API

Benefits:

- Serves both human and embedding workflows without forcing one consumer through another consumer's UX.
- Lets the CLI be a friendly adapter while the client/core remains the stable behavior layer.
- Gives AI-first crontick three complementary surfaces: MCP for agents, API for extension/host code, CLI for human fallback and local scripts.
- The daemon HTTP API can remain private and evolvable because public consumers use CLI/client/MCP.

Disadvantages:

- More public surface area to document and version.
- Drift risk if CLI, client, MCP, and HTTP each encode endpoint paths, defaults, validation, or doctor logic separately.
- Higher test burden: parity tests must cover CLI/client/MCP/API creation, prompt-file normalization, errors, and daemon start policy.
- Public release requires a clear statement of which exports are stable and which are internal/advanced.

Both is the right product architecture, but only if the implementation keeps one source of truth.

## Duplication and drift found

| Area | Current status | Impact | Direction |
|---|---|---|---|
| CLI create/update normalization | Resolved into shared `src\job-input.ts` builders and `CrontickClient.createJobFromCliOptions()` / `updateJob()`. | CLI no longer owns domain validation or prompt-file normalization. | Keep CLI as parse/render only. |
| JSON-file-relative `promptFile` | Resolved with per-call normalization options for create/update/import. | CLI, client, and MCP can share prompt-file semantics. | Keep prompt file reads in core/client helpers. |
| MCP daemon transport | Resolved: MCP tools call `CrontickClient` instead of a local HTTP wrapper. | Endpoint/default/error behavior has one source. | Maintain drift tests for tool/client parity. |
| Client capability gaps | Resolved: client exposes cancel, stats, doctor, daemon lifecycle, logs options, and schema generation. | Embedders can use every public daemon-backed capability without raw HTTP. | Add client methods before new CLI/MCP tools. |
| Doctor duplication | Resolved in `src\doctor.ts`. | Health semantics and check names are shared. | Shims only render structured checks. |
| Daemon lifecycle duplication | Resolved in `src\daemon\lifecycle.ts`. | Explicit start/stop/restart reuse shared core behavior. | Shims only call lifecycle methods and print results. |

## Recommendation

Keep both CLI and programmatic API, and keep MCP as the AI-native public adapter. Do not collapse the project to only one of them.

Target layering for public release:

```text
Public adapters:
  crontick CLI  ─┐
  crontick MCP  ─┼─> public client/core -> internal daemon transport -> daemon core
  Node/TS API   ─┘

Internal implementation:
  daemon HTTP API -> Store + Scheduler + Runner
```

More concretely:

1. The stable behavioral source should be a public client/core layer, not CLI command handlers and not raw HTTP.
2. CLI should parse arguments, handle files/stdin/stdout, render human output, and call the client/core.
3. MCP should define AI-friendly tool schemas, expose only the shared job schema resource, enforce confirmation/redaction conventions, and call the same client/core.
4. HTTP should remain the process-local transport between client/core and daemon. It should be tested, but not promoted as the supported integration API.
5. The daemon should stay independent of public adapters and own state, scheduling, and execution.

This aligns with the intended design artifacts: shared daemon ensure, caller-side prompt-file normalization, a programmatic `CrontickClient`, and CLI/client parity were explicit design goals. It also aligns with the adversarial review's conclusion that the layering is coherent but should keep shared behavior central.

## Low-risk refactor steps

Do not start by deleting surfaces. Instead, reduce drift in small, behavior-preserving steps:

1. Add client methods first for any new public capability.
2. Add shared core validation/builders before adding CLI flags or MCP schemas.
3. Keep MCP tools on `CrontickClient`; do not add raw daemon endpoint calls.
4. Keep CLI commands as argument parsing, local file/stdout UX, and client calls.
5. Extend the surface drift test whenever a capability is intentionally added or removed.

## Public release implications

For a public release, explicitly separate stable public contracts from internal implementation details.

Stable/public documentation should cover:

- CLI commands, flags, exit behavior, and `--json` output compatibility expectations.
- MCP tool names/input schemas and the job schema resource, because agents and skills will depend on them.
- Package root API: `createClient()`, `CrontickClient`, job/schedule/action types, and supported errors.
- Persisted normalized job JSON enough for export/import and backup/restore.

Document as internal or advanced unless intentionally committed to semver:

- Loopback HTTP endpoint paths and response shapes.
- pid/port file locations and daemon lock files.
- Low-level path helpers and daemon ensure helpers are internal module imports; the package root exports the client/core surface, schemas/types, and schema generation helper.

The public-release message should be: use the CLI if you are a human or shell script, use MCP if you are an AI host/agent, and use `createClient()` if you are writing Node/TypeScript. Do not integrate by scraping daemon port files or calling the daemon HTTP API directly.

## AI-first implications

An AI-first cron needs surfaces that are both agent-friendly and safe:

- MCP is essential because AI hosts need declarative tools, schemas, and confirmation guidance. It is the best surface for scheduling prompts/agents.
- The programmatic API is essential because future Copilot extensions, desktop apps, web dashboards, or agent runtimes may want to create jobs without an MCP round trip or shell command.
- The CLI remains essential because agents often need to show users an exact fallback command, plugin installers need a simple `doctor`, and humans need to inspect or repair state outside an AI host.
- The daemon HTTP API is necessary for process isolation, but making it the public contract would push AI clients toward low-level transport details rather than intent-level operations.

Therefore the architecture should be multi-surface at the edges, single-source in the middle.
