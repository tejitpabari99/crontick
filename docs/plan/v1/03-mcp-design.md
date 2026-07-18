# Cron MCP Server Design

Artifact: `03-mcp-design.md`
Status: implementation specification for extracting `cron-job` into standalone NPM package `cron` and adding an MCP server.

> Existing daemon REST surface inspected from `lib/daemon/api.mjs`: health, jobs CRUD, enable/disable/run-now, runs, run tail SSE, stats, reload, shutdown, open/reveal, and static dashboard. Existing job schema v3 is reflected in the common schemas below.

## ⚠️ V2 AMENDMENT (2026-07-18) — read this first.

- **Package = `crontick`.** Rename every MCP tool id from `cron_*` to `crontick_*`. Rename every resource URI from `cron://` to `crontick://`.
- **§2 Server topology — drop the "standalone HTTP MCP server" mode entirely.** stdio-only for v1. The daemon still exposes its localhost HTTP API for the CLI and dashboard, but there is no `/mcp` HTTP endpoint. The stdio MCP server (`crontick mcp`) is a thin process that forwards to the local daemon HTTP API on `127.0.0.1`.
- **§4 Authentication & security — DELETE.** No tokens, no `~/.cron/token`, no bearer, no rotation, no `crontick_token_rotate` tool. Trust boundary = local OS user. Add a single sentence to the README: "The daemon binds to 127.0.0.1 only. Anyone with local shell access can control it."
- **Drop these tools** from the §3 catalog:
    - `cron_migrate_from_copilot_ext` (no migration in v1)
    - `cron_daemon_shutdown` (dangerous with no auth boundary; require CLI)
    - Any `cron_token_*` / auth-related tools
    - Any LLM-provider tools or fields (there is no `llm-prompt` action kind)
- **§3 `crontick_job_create` input schema** — remove all LLM-related fields. Only `action.kind ∈ {script, exec}`.
    - `script`: `{ script: string, shell?: "auto"|"bash"|"pwsh"|"cmd", cwd?, env?, timeoutSec? }`
    - `exec`: `{ command: string, args: string[], shell?: false, cwd?, env?, timeoutSec? }`
- **§5 Copilot skill design** — the skill's decision tree changes: given a user's intent, the LLM **drafts a shell script**, then calls validate → preview → create with `action.kind = "script"`. It never selects a "provider". If the user's task involves invoking an LLM (e.g. `copilot -p "..."`), that command goes *inside the script*. The skill file ships bundled in the npm package at `src/skill/SKILL.md` and is copied to `~/.copilot/skills/crontick/SKILL.md` by the marketplace plugin.
- **§6 Host configs** — keep only the `stdio` snippet variants. Drop all `http` transport examples.
- **§7 Testing MCP** — drop HTTP-transport contract tests and auth handshake tests; keep everything else.
- **§8 Open questions** — most are resolved by V2; re-triage before implementation.

Everything else (initialize handshake spec, tool JSON Schema shape, resource URIs, prompt templates, contract testing patterns, snapshot tests, host registration for Copilot/Claude Desktop/Cursor/Continue/Cline/Zed via stdio) remains authoritative.

---

## 1. MCP fundamentals recap

Model Context Protocol (MCP) is a JSON-RPC 2.0 protocol for connecting LLM host applications to external context and actions. The public spec is at <https://modelcontextprotocol.io/specification/2025-06-18>. The TypeScript SDK is hosted at <https://github.com/modelcontextprotocol/typescript-sdk>; for the current production package use `@modelcontextprotocol/sdk`, while monitoring the SDK repository for the v2 split packages.

MCP servers expose tools, resources, and prompts. Tools are model-controlled callable functions with input JSON Schema and optional output schema. Resources are application-controlled context addressed by URI and can be listed, read, and optionally subscribed to. Prompts are user-controlled reusable templates that hosts may expose as slash commands or prompt starters.

The initialize handshake is mandatory. A client sends `initialize` with protocol version, client capabilities, and client info. The server responds with negotiated protocol version, capabilities (`tools`, `resources`, `prompts`, logging, completions, subscriptions as applicable), server info, and optional instructions. The client then sends `notifications/initialized`; normal calls begin after that.

Transports are separate from features. `stdio` means the host starts a subprocess and exchanges newline-delimited JSON-RPC over stdin/stdout while stderr is logs. Streamable HTTP means the server exposes one endpoint such as `/mcp`; clients POST JSON-RPC and accept `application/json` or `text/event-stream`, and may GET an SSE stream for server notifications. Legacy HTTP+SSE can be supported for compatibility, but Streamable HTTP is the target.

For this package, MCP is the public automation API. The daemon remains the scheduler and persistence authority. The stdio MCP server and HTTP MCP endpoint must forward into the same daemon services so behavior is identical across Copilot, Claude Desktop, Cursor, Continue, Cline/RooCode, Zed, and tests.

## 2. Server topology

### 2.1 Default: in-process stdio server (`cron mcp`)
- Default deployment for local MCP hosts.
- Spawned per LLM client as a subprocess.
- Discovers or starts the local daemon, then forwards tool calls to loopback REST or package services.
- No bearer token; trust boundary is the OS user that launched the process.
- Best compatibility for Claude Desktop, Cursor, Copilot MCP, Continue, Cline/RooCode, and Zed.

### 2.2 Optional: standalone daemon HTTP MCP server
- Daemon exposes Streamable HTTP at `http://127.0.0.1:{port}/mcp` with optional legacy `/mcp/sse`.
- Uses same listener as `/api/*` and dashboard, but its own bearer auth and session handling.
- Protected by `Authorization: Bearer <token>` from `~/.cron/token`.
- Off by default; enable with `cron daemon --mcp-http` or package config.
- Useful for automation and hosts that can share one persistent MCP endpoint.

| Dimension | `cron mcp` stdio | Daemon `/mcp` HTTP |
|---|---|---|
| Default | Yes | No |
| Auth | OS-user trust | Bearer token + Origin validation |
| Lifecycle | Per-host subprocess | Long-lived daemon sessions |
| Compatibility | Highest | Host-dependent |
| Complexity | Low | Medium |
| Blast radius | One subprocess | Shared endpoint until token rotated |

## 3. Tool catalog

- All tools return structured content matching the output schema plus concise text for older hosts.
- All write tools are registered with MCP metadata `dangerous: true` and require `x_cron_confirm: true`.
- All read tools use read-only annotations and must not mutate state.
- Large logs are exposed by `cron://runs/{id}/log` and `tail_url`, not pasted by default.
- All object schemas below set `additionalProperties: false`.

### tool: `cron_job_create`

Description: Create and schedule a new cron job after validation and preview.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"description":{"type":"string","minLength":1},"enabled":{"type":"boolean","default":true},"schedule":{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["cron","interval","one-shot"]},"cron":{"type":"string","pattern":"^\\S+(\\s+\\S+){4,5}$"},"timezone":{"type":"string","minLength":1},"every":{"type":"string","pattern":"^every (\\d+)(s|m|h|d)$"},"at":{"type":"string","format":"date-time"},"jitterSec":{"type":"integer","minimum":0,"maximum":3600,"default":0},"until":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"maxRuns":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"cron"}},"required":["kind"]},"then":{"required":["cron","timezone"],"not":{"anyOf":[{"required":["every"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"interval"}},"required":["kind"]},"then":{"required":["every"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"one-shot"}},"required":["kind"]},"then":{"required":["at"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["every"]},{"required":["until"]}]}}}]},"action":{"type":"object","additionalProperties":false,"required":["kind","runtime","timeoutSec"],"properties":{"kind":{"type":"string","enum":["copilot-prompt","script"]},"runtime":{"type":"string","enum":["copilot","agency","script"]},"prompt":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"cwd":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"timeoutSec":{"type":"integer","minimum":1,"maximum":86400},"agent":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"allowAllTools":{"type":"boolean","default":false},"availableTools":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"allowedDirs":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"attachments":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"resumeSessionId":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"sharedSession":{"type":"boolean","default":false},"script":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"shell":{"type":"string","enum":["powershell","cmd","bash","node","auto"],"default":"auto"},"scriptPath":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"copilot-prompt"}},"required":["kind"]},"then":{"properties":{"prompt":{"type":"string","minLength":1}},"required":["prompt"]}},{"if":{"properties":{"kind":{"const":"script"}},"required":["kind"]},"then":{"anyOf":[{"properties":{"script":{"type":"string","minLength":1}},"required":["script"]},{"properties":{"scriptPath":{"type":"string","minLength":1}},"required":["scriptPath"]}]}}]},"output":{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["stdout-only","file"]},"path":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"appendRunLog":{"type":"boolean","default":false}},"allOf":[{"if":{"properties":{"kind":{"const":"file"}},"required":["kind"]},"then":{"properties":{"path":{"type":"string","minLength":1}},"required":["path"]}}]},"retry":{"type":"object","additionalProperties":false,"required":["maxAttempts","backoffSec"],"properties":{"maxAttempts":{"type":"integer","minimum":0,"maximum":5},"backoffSec":{"type":"integer","minimum":0,"maximum":86400}}},"budgets":{"type":"object","additionalProperties":false,"required":["maxRunsPerDay","maxTokensPerRun"],"properties":{"maxRunsPerDay":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}]},"maxTokensPerRun":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}]}}},"catchup":{"type":"string","enum":["run-once","run-all","skip"],"default":"skip"},"overlap":{"type":"string","enum":["skip","queue","cancel-previous"],"default":"skip"},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128},"x_cron_confirm":{"type":"boolean","const":true,"description":"Required for write tools after user/policy confirmation."},"dangerous":{"type":"boolean","const":true,"description":"Required acknowledgement for dangerous write tools."}},"required":["id","description","schedule","action","x_cron_confirm","dangerous"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","job","path","nextRunAt"],"properties":{"ok":{"type":"boolean","const":true},"job":{"type":"object","additionalProperties":false,"required":["$schemaVersion","id","description","enabled","createdAt","updatedAt","catchup","overlap","schedule","action","output","retry","budgets"],"properties":{"$schemaVersion":{"type":"integer","const":3},"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"description":{"type":"string"},"enabled":{"type":"boolean"},"createdAt":{"type":"string","format":"date-time"},"updatedAt":{"type":"string","format":"date-time"},"catchup":{"type":"string","enum":["run-once","run-all","skip"]},"overlap":{"type":"string","enum":["skip","queue","cancel-previous"]},"schedule":{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["cron","interval","one-shot"]},"cron":{"type":"string","pattern":"^\\S+(\\s+\\S+){4,5}$"},"timezone":{"type":"string","minLength":1},"every":{"type":"string","pattern":"^every (\\d+)(s|m|h|d)$"},"at":{"type":"string","format":"date-time"},"jitterSec":{"type":"integer","minimum":0,"maximum":3600,"default":0},"until":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"maxRuns":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"cron"}},"required":["kind"]},"then":{"required":["cron","timezone"],"not":{"anyOf":[{"required":["every"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"interval"}},"required":["kind"]},"then":{"required":["every"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"one-shot"}},"required":["kind"]},"then":{"required":["at"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["every"]},{"required":["until"]}]}}}]},"action":{"type":"object","additionalProperties":false,"required":["kind","runtime","timeoutSec"],"properties":{"kind":{"type":"string","enum":["copilot-prompt","script"]},"runtime":{"type":"string","enum":["copilot","agency","script"]},"prompt":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"cwd":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"timeoutSec":{"type":"integer","minimum":1,"maximum":86400},"agent":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"allowAllTools":{"type":"boolean","default":false},"availableTools":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"allowedDirs":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"attachments":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"resumeSessionId":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"sharedSession":{"type":"boolean","default":false},"script":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"shell":{"type":"string","enum":["powershell","cmd","bash","node","auto"],"default":"auto"},"scriptPath":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"copilot-prompt"}},"required":["kind"]},"then":{"properties":{"prompt":{"type":"string","minLength":1}},"required":["prompt"]}},{"if":{"properties":{"kind":{"const":"script"}},"required":["kind"]},"then":{"anyOf":[{"properties":{"script":{"type":"string","minLength":1}},"required":["script"]},{"properties":{"scriptPath":{"type":"string","minLength":1}},"required":["scriptPath"]}]}}]},"output":{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["stdout-only","file"]},"path":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"appendRunLog":{"type":"boolean","default":false}},"allOf":[{"if":{"properties":{"kind":{"const":"file"}},"required":["kind"]},"then":{"properties":{"path":{"type":"string","minLength":1}},"required":["path"]}}]},"retry":{"type":"object","additionalProperties":false,"required":["maxAttempts","backoffSec"],"properties":{"maxAttempts":{"type":"integer","minimum":0,"maximum":5},"backoffSec":{"type":"integer","minimum":0,"maximum":86400}}},"budgets":{"type":"object","additionalProperties":false,"required":["maxRunsPerDay","maxTokensPerRun"],"properties":{"maxRunsPerDay":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}]},"maxTokensPerRun":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}]}}}}},"path":{"type":"string"},"nextRunAt":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}]}}}
```

Idempotency: No by default; use `idempotencyKey` where supported and enforce atomic writes.

Errors:
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"id":"daily-summary","description":"Summarize work every weekday at 9am","schedule":{"kind":"cron","cron":"0 9 * * mon-fri","timezone":"America/Los_Angeles","maxRuns":30},"action":{"kind":"copilot-prompt","runtime":"copilot","prompt":"Summarize yesterday's work.","cwd":"Q:\\Repos","timeoutSec":900},"output":{"kind":"file","path":"C:\\Users\\tejitpabari\\Documents\\daily-summary-{{date}}.md","appendRunLog":true},"catchup":"skip","overlap":"skip","idempotencyKey":"daily-summary-20260717","x_cron_confirm":true,"dangerous":true}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: POST /api/jobs.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_job_list`

Description: List jobs with optional enabled filters and next-fire computation.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"enabled":{"type":"string","enum":["true","false","all"],"default":"all"},"includeNext":{"type":"boolean","default":true},"includeLastRun":{"type":"boolean","default":true},"limit":{"type":"integer","minimum":1,"maximum":500,"default":100},"cursor":{"anyOf":[{"type":"string"},{"type":"null"}],"default":null}}}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","jobs","nextCursor"],"properties":{"ok":{"type":"boolean","const":true},"jobs":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["$schemaVersion","id","description","enabled","createdAt","updatedAt","catchup","overlap","schedule","action","output","retry","budgets"],"properties":{"$schemaVersion":{"type":"integer","const":3},"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"description":{"type":"string"},"enabled":{"type":"boolean"},"createdAt":{"type":"string","format":"date-time"},"updatedAt":{"type":"string","format":"date-time"},"catchup":{"type":"string","enum":["run-once","run-all","skip"]},"overlap":{"type":"string","enum":["skip","queue","cancel-previous"]},"schedule":{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["cron","interval","one-shot"]},"cron":{"type":"string","pattern":"^\\S+(\\s+\\S+){4,5}$"},"timezone":{"type":"string","minLength":1},"every":{"type":"string","pattern":"^every (\\d+)(s|m|h|d)$"},"at":{"type":"string","format":"date-time"},"jitterSec":{"type":"integer","minimum":0,"maximum":3600,"default":0},"until":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"maxRuns":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"cron"}},"required":["kind"]},"then":{"required":["cron","timezone"],"not":{"anyOf":[{"required":["every"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"interval"}},"required":["kind"]},"then":{"required":["every"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"one-shot"}},"required":["kind"]},"then":{"required":["at"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["every"]},{"required":["until"]}]}}}]},"action":{"type":"object","additionalProperties":false,"required":["kind","runtime","timeoutSec"],"properties":{"kind":{"type":"string","enum":["copilot-prompt","script"]},"runtime":{"type":"string","enum":["copilot","agency","script"]},"prompt":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"cwd":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"timeoutSec":{"type":"integer","minimum":1,"maximum":86400},"agent":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"allowAllTools":{"type":"boolean","default":false},"availableTools":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"allowedDirs":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"attachments":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"resumeSessionId":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"sharedSession":{"type":"boolean","default":false},"script":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"shell":{"type":"string","enum":["powershell","cmd","bash","node","auto"],"default":"auto"},"scriptPath":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"copilot-prompt"}},"required":["kind"]},"then":{"properties":{"prompt":{"type":"string","minLength":1}},"required":["prompt"]}},{"if":{"properties":{"kind":{"const":"script"}},"required":["kind"]},"then":{"anyOf":[{"properties":{"script":{"type":"string","minLength":1}},"required":["script"]},{"properties":{"scriptPath":{"type":"string","minLength":1}},"required":["scriptPath"]}]}}]},"output":{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["stdout-only","file"]},"path":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"appendRunLog":{"type":"boolean","default":false}},"allOf":[{"if":{"properties":{"kind":{"const":"file"}},"required":["kind"]},"then":{"properties":{"path":{"type":"string","minLength":1}},"required":["path"]}}]},"retry":{"type":"object","additionalProperties":false,"required":["maxAttempts","backoffSec"],"properties":{"maxAttempts":{"type":"integer","minimum":0,"maximum":5},"backoffSec":{"type":"integer","minimum":0,"maximum":86400}}},"budgets":{"type":"object","additionalProperties":false,"required":["maxRunsPerDay","maxTokensPerRun"],"properties":{"maxRunsPerDay":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}]},"maxTokensPerRun":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}]}}}}}},"nextCursor":{"anyOf":[{"type":"string"},{"type":"null"}]}}}
```

Idempotency: Yes; read-only.

Errors:
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"id":"daily-summary"}
```

Example response:
```json
{"ok":true,"jobs":[],"nextCursor":null}
```

Notes:
- Backend mapping: GET /api/jobs.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_job_get`

Description: Fetch one job with computed state and recent run details.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"includeArtifacts":{"type":"boolean","default":false},"recentRuns":{"type":"integer","minimum":0,"maximum":50,"default":5}},"required":["id"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","job","computed"],"properties":{"ok":{"type":"boolean","const":true},"job":{"type":"object","additionalProperties":false,"required":["$schemaVersion","id","description","enabled","createdAt","updatedAt","catchup","overlap","schedule","action","output","retry","budgets"],"properties":{"$schemaVersion":{"type":"integer","const":3},"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"description":{"type":"string"},"enabled":{"type":"boolean"},"createdAt":{"type":"string","format":"date-time"},"updatedAt":{"type":"string","format":"date-time"},"catchup":{"type":"string","enum":["run-once","run-all","skip"]},"overlap":{"type":"string","enum":["skip","queue","cancel-previous"]},"schedule":{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["cron","interval","one-shot"]},"cron":{"type":"string","pattern":"^\\S+(\\s+\\S+){4,5}$"},"timezone":{"type":"string","minLength":1},"every":{"type":"string","pattern":"^every (\\d+)(s|m|h|d)$"},"at":{"type":"string","format":"date-time"},"jitterSec":{"type":"integer","minimum":0,"maximum":3600,"default":0},"until":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"maxRuns":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"cron"}},"required":["kind"]},"then":{"required":["cron","timezone"],"not":{"anyOf":[{"required":["every"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"interval"}},"required":["kind"]},"then":{"required":["every"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"one-shot"}},"required":["kind"]},"then":{"required":["at"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["every"]},{"required":["until"]}]}}}]},"action":{"type":"object","additionalProperties":false,"required":["kind","runtime","timeoutSec"],"properties":{"kind":{"type":"string","enum":["copilot-prompt","script"]},"runtime":{"type":"string","enum":["copilot","agency","script"]},"prompt":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"cwd":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"timeoutSec":{"type":"integer","minimum":1,"maximum":86400},"agent":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"allowAllTools":{"type":"boolean","default":false},"availableTools":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"allowedDirs":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"attachments":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"resumeSessionId":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"sharedSession":{"type":"boolean","default":false},"script":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"shell":{"type":"string","enum":["powershell","cmd","bash","node","auto"],"default":"auto"},"scriptPath":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"copilot-prompt"}},"required":["kind"]},"then":{"properties":{"prompt":{"type":"string","minLength":1}},"required":["prompt"]}},{"if":{"properties":{"kind":{"const":"script"}},"required":["kind"]},"then":{"anyOf":[{"properties":{"script":{"type":"string","minLength":1}},"required":["script"]},{"properties":{"scriptPath":{"type":"string","minLength":1}},"required":["scriptPath"]}]}}]},"output":{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["stdout-only","file"]},"path":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"appendRunLog":{"type":"boolean","default":false}},"allOf":[{"if":{"properties":{"kind":{"const":"file"}},"required":["kind"]},"then":{"properties":{"path":{"type":"string","minLength":1}},"required":["path"]}}]},"retry":{"type":"object","additionalProperties":false,"required":["maxAttempts","backoffSec"],"properties":{"maxAttempts":{"type":"integer","minimum":0,"maximum":5},"backoffSec":{"type":"integer","minimum":0,"maximum":86400}}},"budgets":{"type":"object","additionalProperties":false,"required":["maxRunsPerDay","maxTokensPerRun"],"properties":{"maxRunsPerDay":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}]},"maxTokensPerRun":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}]}}}}},"computed":{"type":"object","additionalProperties":true}}}
```

Idempotency: Yes; read-only.

Errors:
- `JOB_NOT_FOUND`
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"id":"daily-summary"}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: GET /api/jobs/:id.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_job_update`

Description: Merge-patch, validate, and reschedule an existing job atomically.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"patch":{"type":"object","additionalProperties":true},"expectedUpdatedAt":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128},"x_cron_confirm":{"type":"boolean","const":true,"description":"Required for write tools after user/policy confirmation."},"dangerous":{"type":"boolean","const":true,"description":"Required acknowledgement for dangerous write tools."}},"required":["id","patch","x_cron_confirm","dangerous"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","job","reload","nextRunAt"],"properties":{"ok":{"type":"boolean","const":true},"job":{"type":"object","additionalProperties":false,"required":["$schemaVersion","id","description","enabled","createdAt","updatedAt","catchup","overlap","schedule","action","output","retry","budgets"],"properties":{"$schemaVersion":{"type":"integer","const":3},"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"description":{"type":"string"},"enabled":{"type":"boolean"},"createdAt":{"type":"string","format":"date-time"},"updatedAt":{"type":"string","format":"date-time"},"catchup":{"type":"string","enum":["run-once","run-all","skip"]},"overlap":{"type":"string","enum":["skip","queue","cancel-previous"]},"schedule":{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["cron","interval","one-shot"]},"cron":{"type":"string","pattern":"^\\S+(\\s+\\S+){4,5}$"},"timezone":{"type":"string","minLength":1},"every":{"type":"string","pattern":"^every (\\d+)(s|m|h|d)$"},"at":{"type":"string","format":"date-time"},"jitterSec":{"type":"integer","minimum":0,"maximum":3600,"default":0},"until":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"maxRuns":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"cron"}},"required":["kind"]},"then":{"required":["cron","timezone"],"not":{"anyOf":[{"required":["every"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"interval"}},"required":["kind"]},"then":{"required":["every"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"one-shot"}},"required":["kind"]},"then":{"required":["at"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["every"]},{"required":["until"]}]}}}]},"action":{"type":"object","additionalProperties":false,"required":["kind","runtime","timeoutSec"],"properties":{"kind":{"type":"string","enum":["copilot-prompt","script"]},"runtime":{"type":"string","enum":["copilot","agency","script"]},"prompt":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"cwd":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"timeoutSec":{"type":"integer","minimum":1,"maximum":86400},"agent":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"allowAllTools":{"type":"boolean","default":false},"availableTools":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"allowedDirs":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"attachments":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"resumeSessionId":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"sharedSession":{"type":"boolean","default":false},"script":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"shell":{"type":"string","enum":["powershell","cmd","bash","node","auto"],"default":"auto"},"scriptPath":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"copilot-prompt"}},"required":["kind"]},"then":{"properties":{"prompt":{"type":"string","minLength":1}},"required":["prompt"]}},{"if":{"properties":{"kind":{"const":"script"}},"required":["kind"]},"then":{"anyOf":[{"properties":{"script":{"type":"string","minLength":1}},"required":["script"]},{"properties":{"scriptPath":{"type":"string","minLength":1}},"required":["scriptPath"]}]}}]},"output":{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["stdout-only","file"]},"path":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"appendRunLog":{"type":"boolean","default":false}},"allOf":[{"if":{"properties":{"kind":{"const":"file"}},"required":["kind"]},"then":{"properties":{"path":{"type":"string","minLength":1}},"required":["path"]}}]},"retry":{"type":"object","additionalProperties":false,"required":["maxAttempts","backoffSec"],"properties":{"maxAttempts":{"type":"integer","minimum":0,"maximum":5},"backoffSec":{"type":"integer","minimum":0,"maximum":86400}}},"budgets":{"type":"object","additionalProperties":false,"required":["maxRunsPerDay","maxTokensPerRun"],"properties":{"maxRunsPerDay":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}]},"maxTokensPerRun":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}]}}}}},"reload":{"type":"object","additionalProperties":false,"required":["updated"],"properties":{"updated":{"type":"array","items":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."}}}},"nextRunAt":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}]}}}
```

Idempotency: No by default; use `idempotencyKey` where supported and enforce atomic writes.

Errors:
- `JOB_NOT_FOUND`
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"id":"daily-summary","patch":{"enabled":false},"expectedUpdatedAt":"2026-07-18T07:00:00Z","idempotencyKey":"disable-daily-summary-1","x_cron_confirm":true,"dangerous":true}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: PATCH /api/jobs/:id.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_job_delete`

Description: Delete a job and its persisted run/log data.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"deleteRuns":{"type":"boolean","default":true},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128},"x_cron_confirm":{"type":"boolean","const":true,"description":"Required for write tools after user/policy confirmation."},"dangerous":{"type":"boolean","const":true,"description":"Required acknowledgement for dangerous write tools."}},"required":["id","x_cron_confirm","dangerous"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","deleted","deletedRuns","logsDeleted"],"properties":{"ok":{"type":"boolean","const":true},"deleted":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"deletedRuns":{"type":"integer","minimum":0},"logsDeleted":{"type":"boolean"}}}
```

Idempotency: No by default; use `idempotencyKey` where supported and enforce atomic writes.

Errors:
- `JOB_NOT_FOUND`
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"id":"daily-summary","x_cron_confirm":true,"dangerous":true}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: DELETE /api/jobs/:id.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_job_enable`

Description: Enable a disabled job and schedule future fires.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128},"x_cron_confirm":{"type":"boolean","const":true,"description":"Required for write tools after user/policy confirmation."},"dangerous":{"type":"boolean","const":true,"description":"Required acknowledgement for dangerous write tools."}},"required":["id","x_cron_confirm","dangerous"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","id","enabled","nextRunAt"],"properties":{"ok":{"type":"boolean","const":true},"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"enabled":{"type":"boolean"},"nextRunAt":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}]}}}
```

Idempotency: No by default; use `idempotencyKey` where supported and enforce atomic writes.

Errors:
- `JOB_NOT_FOUND`
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"id":"daily-summary","x_cron_confirm":true,"dangerous":true}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: POST /api/jobs/:id/enable.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_job_disable`

Description: Disable a job without deleting its history.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128},"x_cron_confirm":{"type":"boolean","const":true,"description":"Required for write tools after user/policy confirmation."},"dangerous":{"type":"boolean","const":true,"description":"Required acknowledgement for dangerous write tools."}},"required":["id","x_cron_confirm","dangerous"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","id","enabled","nextRunAt"],"properties":{"ok":{"type":"boolean","const":true},"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"enabled":{"type":"boolean"},"nextRunAt":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}]}}}
```

Idempotency: No by default; use `idempotencyKey` where supported and enforce atomic writes.

Errors:
- `JOB_NOT_FOUND`
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"id":"daily-summary","x_cron_confirm":true,"dangerous":true}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: POST /api/jobs/:id/disable.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_job_run_now`

Description: Start a manual run immediately.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"force":{"type":"boolean","default":false},"wait":{"type":"boolean","default":false},"waitTimeoutSec":{"type":"integer","minimum":1,"maximum":86400,"default":300},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128},"x_cron_confirm":{"type":"boolean","const":true,"description":"Required for write tools after user/policy confirmation."},"dangerous":{"type":"boolean","const":true,"description":"Required acknowledgement for dangerous write tools."}},"required":["id","x_cron_confirm","dangerous"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","runId","status","tailUrl","runResource"],"properties":{"ok":{"type":"boolean","const":true},"runId":{"type":"string","minLength":1,"description":"Run id."},"status":{"type":"string"},"tailUrl":{"type":"string","format":"uri"},"runResource":{"type":"string","format":"uri"}}}
```

Idempotency: No by default; use `idempotencyKey` where supported and enforce atomic writes.

Errors:
- `JOB_NOT_FOUND`
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"id":"daily-summary","x_cron_confirm":true,"dangerous":true}
```

Example response:
```json
{"ok":true,"runId":"2026-07-18T07-20-00Z-daily-summary-1","status":"running","tailUrl":"http://127.0.0.1:53127/api/runs/2026-07-18T07-20-00Z-daily-summary-1/tail","runResource":"cron://runs/2026-07-18T07-20-00Z-daily-summary-1"}
```

Notes:
- Backend mapping: POST /api/jobs/:id/run-now.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_job_cancel_run`

Description: Cancel an active or queued run. (provisional: add daemon cancel support.)

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"runId":{"anyOf":[{"type":"string","minLength":1,"description":"Run id."},{"type":"null"}],"default":null},"reason":{"type":"string","minLength":1,"maxLength":500},"x_cron_confirm":{"type":"boolean","const":true,"description":"Required for write tools after user/policy confirmation."},"dangerous":{"type":"boolean","const":true,"description":"Required acknowledgement for dangerous write tools."}},"required":["id","reason","x_cron_confirm","dangerous"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","runId","status","cancelledAt"],"properties":{"ok":{"type":"boolean","const":true},"runId":{"type":"string","minLength":1,"description":"Run id."},"status":{"type":"string","const":"cancelled"},"cancelledAt":{"type":"string","format":"date-time"}}}
```

Idempotency: No by default; use `idempotencyKey` where supported and enforce atomic writes.

Errors:
- `JOB_NOT_FOUND`
- `RUN_NOT_FOUND`
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"id":"daily-summary","x_cron_confirm":true,"dangerous":true}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: provisional.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_run_list`

Description: List historical runs globally or for one job.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"jobId":{"anyOf":[{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},{"type":"null"}],"default":null},"status":{"anyOf":[{"type":"string","enum":["queued","running","success","failure","timeout","skipped","cancelled","missed"]},{"type":"null"}],"default":null},"since":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"until":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"limit":{"type":"integer","minimum":1,"maximum":500,"default":100},"sort":{"type":"string","enum":["startedAt","endedAt","status","jobId"],"default":"startedAt"},"dir":{"type":"string","enum":["asc","desc"],"default":"desc"},"cursor":{"anyOf":[{"type":"string"},{"type":"null"}],"default":null}}}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","runs","nextCursor"],"properties":{"ok":{"type":"boolean","const":true},"runs":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["runId","jobId","status","trigger","startedAt"],"properties":{"runId":{"type":"string","minLength":1,"description":"Run id."},"jobId":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"status":{"type":"string","enum":["queued","running","success","failure","timeout","skipped","cancelled","missed"]},"trigger":{"type":"string","enum":["scheduled","manual","retry","catchup","system"]},"startedAt":{"type":"string","format":"date-time"},"endedAt":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"exitCode":{"anyOf":[{"type":"integer"},{"type":"null"}],"default":null},"durationMs":{"anyOf":[{"type":"integer","minimum":0},{"type":"null"}],"default":null},"logPath":{"anyOf":[{"type":"string"},{"type":"null"}],"default":null},"error":{"anyOf":[{"type":"string"},{"type":"null"}],"default":null},"sessionId":{"anyOf":[{"type":"string"},{"type":"null"}],"default":null}}}},"nextCursor":{"anyOf":[{"type":"string"},{"type":"null"}]}}}
```

Idempotency: Yes; read-only.

Errors:
- `RUN_NOT_FOUND`
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"jobId":"daily-summary","status":"failure","limit":10}
```

Example response:
```json
{"ok":true,"runs":[],"nextCursor":null}
```

Notes:
- Backend mapping: GET /api/runs or /api/jobs/:id/runs.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_run_get`

Description: Fetch a single run record.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"runId":{"type":"string","minLength":1,"description":"Run id."},"includeLogTail":{"type":"integer","minimum":0,"maximum":2000,"default":0}},"required":["runId"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","run","logResource","tailUrl","tail"],"properties":{"ok":{"type":"boolean","const":true},"run":{"type":"object","additionalProperties":false,"required":["runId","jobId","status","trigger","startedAt"],"properties":{"runId":{"type":"string","minLength":1,"description":"Run id."},"jobId":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"status":{"type":"string","enum":["queued","running","success","failure","timeout","skipped","cancelled","missed"]},"trigger":{"type":"string","enum":["scheduled","manual","retry","catchup","system"]},"startedAt":{"type":"string","format":"date-time"},"endedAt":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"exitCode":{"anyOf":[{"type":"integer"},{"type":"null"}],"default":null},"durationMs":{"anyOf":[{"type":"integer","minimum":0},{"type":"null"}],"default":null},"logPath":{"anyOf":[{"type":"string"},{"type":"null"}],"default":null},"error":{"anyOf":[{"type":"string"},{"type":"null"}],"default":null},"sessionId":{"anyOf":[{"type":"string"},{"type":"null"}],"default":null}}},"logResource":{"type":"string","format":"uri"},"tailUrl":{"type":"string","format":"uri"},"tail":{"type":"array","items":{"type":"string"}}}}
```

Idempotency: Yes; read-only.

Errors:
- `RUN_NOT_FOUND`
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"runId":"2026-07-18T07-20-00Z-daily-summary-1"}
```

Example response:
```json
{"ok":true,"runId":"2026-07-18T07-20-00Z-daily-summary-1","logResource":"cron://runs/2026-07-18T07-20-00Z-daily-summary-1/log","tailUrl":"http://127.0.0.1:53127/api/runs/2026-07-18T07-20-00Z-daily-summary-1/tail","lines":["completed"],"streaming":false}
```

Notes:
- Backend mapping: GET /api/runs/:runId.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_run_logs`

Description: Return bounded log tail plus `tail_url` and log resource link.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"runId":{"type":"string","minLength":1,"description":"Run id."},"tailLines":{"type":"integer","minimum":0,"maximum":2000,"default":200},"stream":{"type":"boolean","default":false}},"required":["runId"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","runId","logResource","tailUrl","lines","streaming"],"properties":{"ok":{"type":"boolean","const":true},"runId":{"type":"string","minLength":1,"description":"Run id."},"logResource":{"type":"string","format":"uri"},"tailUrl":{"type":"string","format":"uri"},"lines":{"type":"array","items":{"type":"string"}},"streaming":{"type":"boolean"}}}
```

Idempotency: Yes; read-only.

Errors:
- `RUN_NOT_FOUND`
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"runId":"2026-07-18T07-20-00Z-daily-summary-1"}
```

Example response:
```json
{"ok":true,"runId":"2026-07-18T07-20-00Z-daily-summary-1","logResource":"cron://runs/2026-07-18T07-20-00Z-daily-summary-1/log","tailUrl":"http://127.0.0.1:53127/api/runs/2026-07-18T07-20-00Z-daily-summary-1/tail","lines":["completed"],"streaming":false}
```

Notes:
- Backend mapping: GET /api/runs/:runId/tail.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_schedule_preview`

Description: Compute next N fires for cron/interval/one-shot schedules, DST-aware.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"schedule":{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["cron","interval","one-shot"]},"cron":{"type":"string","pattern":"^\\S+(\\s+\\S+){4,5}$"},"timezone":{"type":"string","minLength":1},"every":{"type":"string","pattern":"^every (\\d+)(s|m|h|d)$"},"at":{"type":"string","format":"date-time"},"jitterSec":{"type":"integer","minimum":0,"maximum":3600,"default":0},"until":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"maxRuns":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"cron"}},"required":["kind"]},"then":{"required":["cron","timezone"],"not":{"anyOf":[{"required":["every"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"interval"}},"required":["kind"]},"then":{"required":["every"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"one-shot"}},"required":["kind"]},"then":{"required":["at"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["every"]},{"required":["until"]}]}}}]},"count":{"type":"integer","minimum":1,"maximum":100,"default":5},"from":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null}},"required":["schedule"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","fires","timezone","dstTransitions"],"properties":{"ok":{"type":"boolean","const":true},"fires":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["at","local","reason"],"properties":{"at":{"type":"string","format":"date-time"},"local":{"type":"string"},"reason":{"type":"string"}}}},"timezone":{"anyOf":[{"type":"string"},{"type":"null"}]},"dstTransitions":{"type":"array","items":{"type":"string"}}}}
```

Idempotency: Yes; read-only.

Errors:
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"schedule":{"kind":"cron","cron":"0 9 * * mon-fri","timezone":"America/Los_Angeles"},"count":5}
```

Example response:
```json
{"ok":true,"fires":[{"at":"2026-07-20T16:00:00Z","local":"2026-07-20 09:00:00 America/Los_Angeles","reason":"cron"}],"timezone":"America/Los_Angeles","dstTransitions":[]}
```

Notes:
- Backend mapping: new pure scheduler service.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_schedule_validate`

Description: Validate syntax and semantics; catch high-frequency abuse.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"schedule":{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["cron","interval","one-shot"]},"cron":{"type":"string","pattern":"^\\S+(\\s+\\S+){4,5}$"},"timezone":{"type":"string","minLength":1},"every":{"type":"string","pattern":"^every (\\d+)(s|m|h|d)$"},"at":{"type":"string","format":"date-time"},"jitterSec":{"type":"integer","minimum":0,"maximum":3600,"default":0},"until":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"maxRuns":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"cron"}},"required":["kind"]},"then":{"required":["cron","timezone"],"not":{"anyOf":[{"required":["every"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"interval"}},"required":["kind"]},"then":{"required":["every"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"one-shot"}},"required":["kind"]},"then":{"required":["at"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["every"]},{"required":["until"]}]}}}]},"now":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"policy":{"type":"object","additionalProperties":false,"properties":{"minIntervalSec":{"type":"integer","minimum":1,"default":60},"maxPreview":{"type":"integer","minimum":1,"maximum":100,"default":10},"allowSubMinute":{"type":"boolean","default":false}},"default":{}}},"required":["schedule"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","valid","normalized","warnings","errors"],"properties":{"ok":{"type":"boolean","const":true},"valid":{"type":"boolean"},"normalized":{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["cron","interval","one-shot"]},"cron":{"type":"string","pattern":"^\\S+(\\s+\\S+){4,5}$"},"timezone":{"type":"string","minLength":1},"every":{"type":"string","pattern":"^every (\\d+)(s|m|h|d)$"},"at":{"type":"string","format":"date-time"},"jitterSec":{"type":"integer","minimum":0,"maximum":3600,"default":0},"until":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"maxRuns":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"cron"}},"required":["kind"]},"then":{"required":["cron","timezone"],"not":{"anyOf":[{"required":["every"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"interval"}},"required":["kind"]},"then":{"required":["every"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"one-shot"}},"required":["kind"]},"then":{"required":["at"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["every"]},{"required":["until"]}]}}}]},"warnings":{"type":"array","items":{"type":"string"}},"errors":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["code","message"],"properties":{"code":{"type":"string"},"message":{"type":"string"},"path":{"type":"string"}}}}}}
```

Idempotency: Yes; read-only.

Errors:
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"schedule":{"kind":"interval","every":"every 1s"},"policy":{"allowSubMinute":false}}
```

Example response:
```json
{"ok":true,"valid":false,"normalized":{"kind":"interval","every":"every 1s"},"warnings":[],"errors":[{"code":"SCHEDULE_TOO_FREQUENT","message":"Minimum interval is 60 seconds.","path":"/every"}]}
```

Notes:
- Backend mapping: new pure validation service.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_stats_summary`

Description: Return aggregate run statistics.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"since":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"until":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null}}}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","computedAt","jobs"],"properties":{"ok":{"type":"boolean","const":true},"computedAt":{"type":"string","format":"date-time"},"jobs":{"type":"object","additionalProperties":true}}}
```

Idempotency: Yes; read-only.

Errors:
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: GET /api/stats.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_stats_job`

Description: Return run statistics for one job.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"includeArtifacts":{"type":"boolean","default":false},"recentRuns":{"type":"integer","minimum":0,"maximum":50,"default":5}},"required":["id"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","job","computed"],"properties":{"ok":{"type":"boolean","const":true},"job":{"anyOf":[{"type":"object","additionalProperties":false,"required":["$schemaVersion","id","description","enabled","createdAt","updatedAt","catchup","overlap","schedule","action","output","retry","budgets"],"properties":{"$schemaVersion":{"type":"integer","const":3},"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"description":{"type":"string"},"enabled":{"type":"boolean"},"createdAt":{"type":"string","format":"date-time"},"updatedAt":{"type":"string","format":"date-time"},"catchup":{"type":"string","enum":["run-once","run-all","skip"]},"overlap":{"type":"string","enum":["skip","queue","cancel-previous"]},"schedule":{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["cron","interval","one-shot"]},"cron":{"type":"string","pattern":"^\\S+(\\s+\\S+){4,5}$"},"timezone":{"type":"string","minLength":1},"every":{"type":"string","pattern":"^every (\\d+)(s|m|h|d)$"},"at":{"type":"string","format":"date-time"},"jitterSec":{"type":"integer","minimum":0,"maximum":3600,"default":0},"until":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"maxRuns":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"cron"}},"required":["kind"]},"then":{"required":["cron","timezone"],"not":{"anyOf":[{"required":["every"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"interval"}},"required":["kind"]},"then":{"required":["every"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"one-shot"}},"required":["kind"]},"then":{"required":["at"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["every"]},{"required":["until"]}]}}}]},"action":{"type":"object","additionalProperties":false,"required":["kind","runtime","timeoutSec"],"properties":{"kind":{"type":"string","enum":["copilot-prompt","script"]},"runtime":{"type":"string","enum":["copilot","agency","script"]},"prompt":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"cwd":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"timeoutSec":{"type":"integer","minimum":1,"maximum":86400},"agent":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"allowAllTools":{"type":"boolean","default":false},"availableTools":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"allowedDirs":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"attachments":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"resumeSessionId":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"sharedSession":{"type":"boolean","default":false},"script":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"shell":{"type":"string","enum":["powershell","cmd","bash","node","auto"],"default":"auto"},"scriptPath":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"copilot-prompt"}},"required":["kind"]},"then":{"properties":{"prompt":{"type":"string","minLength":1}},"required":["prompt"]}},{"if":{"properties":{"kind":{"const":"script"}},"required":["kind"]},"then":{"anyOf":[{"properties":{"script":{"type":"string","minLength":1}},"required":["script"]},{"properties":{"scriptPath":{"type":"string","minLength":1}},"required":["scriptPath"]}]}}]},"output":{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["stdout-only","file"]},"path":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"appendRunLog":{"type":"boolean","default":false}},"allOf":[{"if":{"properties":{"kind":{"const":"file"}},"required":["kind"]},"then":{"properties":{"path":{"type":"string","minLength":1}},"required":["path"]}}]},"retry":{"type":"object","additionalProperties":false,"required":["maxAttempts","backoffSec"],"properties":{"maxAttempts":{"type":"integer","minimum":0,"maximum":5},"backoffSec":{"type":"integer","minimum":0,"maximum":86400}}},"budgets":{"type":"object","additionalProperties":false,"required":["maxRunsPerDay","maxTokensPerRun"],"properties":{"maxRunsPerDay":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}]},"maxTokensPerRun":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}]}}}}},{"type":"null"}]},"computed":{"type":"object","additionalProperties":true}}}
```

Idempotency: Yes; read-only.

Errors:
- `JOB_NOT_FOUND`
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"id":"daily-summary"}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: GET /api/stats/jobs/:id.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_daemon_status`

Description: Check daemon health, PID, version, queues, and MCP endpoint.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"includeConfig":{"type":"boolean","default":false}}}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","uptime","pid","jobsLoaded","invalidJobs","runningRuns","queueDepths","shuttingDown","version","mcp"],"properties":{"ok":{"type":"boolean","const":true},"uptime":{"type":"number"},"pid":{"type":"integer"},"jobsLoaded":{"type":"integer"},"invalidJobs":{"type":"array","items":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."}},"runningRuns":{"type":"integer"},"queueDepths":{"type":"object","additionalProperties":{"type":"integer"}},"shuttingDown":{"type":"boolean"},"version":{"type":"string"},"mcp":{"type":"object","additionalProperties":false,"required":["stdio","http"],"properties":{"stdio":{"type":"boolean"},"http":{"type":"boolean"},"endpoint":{"anyOf":[{"type":"string","format":"uri"},{"type":"null"}]}}}}}
```

Idempotency: Yes; read-only.

Errors:
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{}
```

Example response:
```json
{"ok":true,"uptime":123.4,"pid":12345,"jobsLoaded":2,"invalidJobs":[],"runningRuns":0,"queueDepths":{},"shuttingDown":false,"version":"1.0.0","mcp":{"stdio":true,"http":false,"endpoint":null}}
```

Notes:
- Backend mapping: GET /api/health.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_daemon_reload`

Description: Reload job files and reschedule valid jobs.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"x_cron_confirm":{"type":"boolean","const":true,"description":"Required for write tools after user/policy confirmation."},"dangerous":{"type":"boolean","const":true,"description":"Required acknowledgement for dangerous write tools."}},"required":["x_cron_confirm","dangerous"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","added","updated","removed","invalid"],"properties":{"ok":{"type":"boolean","const":true},"added":{"type":"array","items":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."}},"updated":{"type":"array","items":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."}},"removed":{"type":"array","items":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."}},"invalid":{"type":"array","items":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."}}}}
```

Idempotency: No by default; use `idempotencyKey` where supported and enforce atomic writes.

Errors:
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"id":"daily-summary","x_cron_confirm":true,"dangerous":true}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: POST /api/reload.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_daemon_restart`

Description: Restart daemon and wait for health. (provisional supervisor feature.)

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"x_cron_confirm":{"type":"boolean","const":true,"description":"Required for write tools after user/policy confirmation."},"dangerous":{"type":"boolean","const":true,"description":"Required acknowledgement for dangerous write tools."},"waitSec":{"type":"integer","minimum":1,"maximum":120,"default":30}},"required":["x_cron_confirm","dangerous"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","oldPid","newPid","healthy"],"properties":{"ok":{"type":"boolean","const":true},"oldPid":{"type":"integer"},"newPid":{"type":"integer"},"healthy":{"type":"boolean"}}}
```

Idempotency: No by default; use `idempotencyKey` where supported and enforce atomic writes.

Errors:
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"id":"daily-summary","x_cron_confirm":true,"dangerous":true}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: new package supervisor.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_daemon_shutdown`

Description: Ask daemon to stop after responding.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"x_cron_confirm":{"type":"boolean","const":true,"description":"Required for write tools after user/policy confirmation."},"dangerous":{"type":"boolean","const":true,"description":"Required acknowledgement for dangerous write tools."}},"required":["x_cron_confirm","dangerous"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","message","pid"],"properties":{"ok":{"type":"boolean","const":true},"message":{"type":"string"},"pid":{"type":"integer"}}}
```

Idempotency: No by default; use `idempotencyKey` where supported and enforce atomic writes.

Errors:
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"id":"daily-summary","x_cron_confirm":true,"dangerous":true}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: POST /api/shutdown.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_autostart_status`

Description: Report login autostart and watchdog status.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{}}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","installed","watchdogInstalled","method","details"],"properties":{"ok":{"type":"boolean","const":true},"installed":{"type":"boolean"},"watchdogInstalled":{"type":"boolean"},"method":{"type":"string"},"details":{"type":"object","additionalProperties":true}}}
```

Idempotency: Yes; read-only.

Errors:
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: package autostart service.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_autostart_install`

Description: Install per-user daemon autostart and optional watchdog.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"x_cron_confirm":{"type":"boolean","const":true,"description":"Required for write tools after user/policy confirmation."},"dangerous":{"type":"boolean","const":true,"description":"Required acknowledgement for dangerous write tools."},"watchdog":{"type":"boolean","default":false}},"required":["x_cron_confirm","dangerous"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","installed","watchdogInstalled","method","details"],"properties":{"ok":{"type":"boolean","const":true},"installed":{"type":"boolean"},"watchdogInstalled":{"type":"boolean"},"method":{"type":"string"},"details":{"type":"object","additionalProperties":true}}}
```

Idempotency: No by default; use `idempotencyKey` where supported and enforce atomic writes.

Errors:
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"id":"daily-summary","x_cron_confirm":true,"dangerous":true}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: package autostart service.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_autostart_remove`

Description: Remove per-user daemon autostart and optional watchdog.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"x_cron_confirm":{"type":"boolean","const":true,"description":"Required for write tools after user/policy confirmation."},"dangerous":{"type":"boolean","const":true,"description":"Required acknowledgement for dangerous write tools."},"removeWatchdog":{"type":"boolean","default":true}},"required":["x_cron_confirm","dangerous"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","installed","watchdogInstalled","method","details"],"properties":{"ok":{"type":"boolean","const":true},"installed":{"type":"boolean"},"watchdogInstalled":{"type":"boolean"},"method":{"type":"string"},"details":{"type":"object","additionalProperties":true}}}
```

Idempotency: No by default; use `idempotencyKey` where supported and enforce atomic writes.

Errors:
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"id":"daily-summary","x_cron_confirm":true,"dangerous":true}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: package autostart service.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_export`

Description: Export jobs and optional run metadata to portable JSON.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"includeRuns":{"type":"boolean","default":false},"includeLogs":{"type":"boolean","default":false},"jobIds":{"type":"array","items":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"uniqueItems":true,"default":[]},"destinationPath":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"x_cron_confirm":{"type":"boolean","const":true,"description":"Required for write tools after user/policy confirmation."},"dangerous":{"type":"boolean","const":true,"description":"Required acknowledgement for dangerous write tools."}},"required":["x_cron_confirm","dangerous"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","exportPath","jobCount","runCount","sha256"],"properties":{"ok":{"type":"boolean","const":true},"exportPath":{"type":"string"},"jobCount":{"type":"integer"},"runCount":{"type":"integer"},"sha256":{"type":"string","pattern":"^[a-f0-9]{64}$"}}}
```

Idempotency: No by default; use `idempotencyKey` where supported and enforce atomic writes.

Errors:
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"includeRuns":true,"destinationPath":"C:\\Users\\tejitpabari\\cron-backup.json","x_cron_confirm":true,"dangerous":true}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: package sync service.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_import`

Description: Import a backup with dry-run, merge, or replace mode.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"sourcePath":{"type":"string","minLength":1},"mode":{"type":"string","enum":["merge","replace","dry-run"],"default":"merge"},"onConflict":{"type":"string","enum":["skip","overwrite","fail"],"default":"fail"},"x_cron_confirm":{"type":"boolean","const":true,"description":"Required for write tools after user/policy confirmation."},"dangerous":{"type":"boolean","const":true,"description":"Required acknowledgement for dangerous write tools."}},"required":["sourcePath","x_cron_confirm","dangerous"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","mode","created","updated","skipped","errors"],"properties":{"ok":{"type":"boolean","const":true},"mode":{"type":"string"},"created":{"type":"array","items":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."}},"updated":{"type":"array","items":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."}},"skipped":{"type":"array","items":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."}},"errors":{"type":"array","items":{"type":"string"}}}}
```

Idempotency: No by default; use `idempotencyKey` where supported and enforce atomic writes.

Errors:
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"sourcePath":"C:\\Users\\tejitpabari\\cron-backup.json","mode":"dry-run","onConflict":"fail","x_cron_confirm":true,"dangerous":true}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: package sync service.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_dashboard_open`

Description: Open dashboard or return its URL.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"open":{"type":"boolean","default":true},"revealPath":{"anyOf":[{"type":"string"},{"type":"null"}],"default":null},"x_cron_confirm":{"type":"boolean","default":false},"dangerous":{"type":"boolean","default":false}}}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","url","opened"],"properties":{"ok":{"type":"boolean","const":true},"url":{"type":"string","format":"uri"},"opened":{"type":"boolean"}}}
```

Idempotency: Yes-ish; visible side effect only, no persistent scheduler mutation.

Errors:
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"open":true}
```

Example response:
```json
{"ok":true,"url":"http://127.0.0.1:53127/","opened":true}
```

Notes:
- Backend mapping: POST /api/open/dashboard.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_migrate_from_copilot_ext`

Description: Migrate from legacy Copilot extension cron roots. (provisional.)

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"sourceRoot":{"anyOf":[{"type":"string"},{"type":"null"}],"default":null},"dryRun":{"type":"boolean","default":true},"preserveSource":{"type":"boolean","default":true},"x_cron_confirm":{"type":"boolean","const":true,"description":"Required for write tools after user/policy confirmation."},"dangerous":{"type":"boolean","const":true,"description":"Required acknowledgement for dangerous write tools."}},"required":["x_cron_confirm","dangerous"]}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","dryRun","sourceRoot","targetRoot","jobsMigrated","filesCopied","warnings"],"properties":{"ok":{"type":"boolean","const":true},"dryRun":{"type":"boolean"},"sourceRoot":{"type":"string"},"targetRoot":{"type":"string"},"jobsMigrated":{"type":"integer"},"filesCopied":{"type":"integer"},"warnings":{"type":"array","items":{"type":"string"}}}}
```

Idempotency: No by default; use `idempotencyKey` where supported and enforce atomic writes.

Errors:
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"id":"daily-summary","x_cron_confirm":true,"dangerous":true}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: package migration service.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### tool: `cron_doctor`

Description: Run diagnostics and optionally fix stale local state.

Input schema (JSON Schema):
```json
{"type":"object","additionalProperties":false,"properties":{"fix":{"type":"boolean","default":false},"deep":{"type":"boolean","default":false},"x_cron_confirm":{"type":"boolean","default":false},"dangerous":{"type":"boolean","default":false}}}
```

Output schema:
```json
{"type":"object","additionalProperties":false,"required":["ok","healthy","checks","fixed"],"properties":{"ok":{"type":"boolean","const":true},"healthy":{"type":"boolean"},"checks":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["name","status","message"],"properties":{"name":{"type":"string"},"status":{"type":"string","enum":["pass","warn","fail","fixed"]},"message":{"type":"string"}}}},"fixed":{"type":"array","items":{"type":"string"}}}}
```

Idempotency: Yes-ish; visible side effect only, no persistent scheduler mutation.

Errors:
- `PARSE_ERROR`
- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `DAEMON_UNAVAILABLE`
- `INTERNAL_ERROR`

Example call:
```json
{"fix":false,"deep":true}
```

Example response:
```json
{"ok":true}
```

Notes:
- Backend mapping: package doctor service.
- Validate arguments before calling daemon REST.
- Return normalized error codes as MCP tool execution errors, not protocol errors.
- Rate-limit if the tool can mutate state or start work.

### Resources

| URI template | MIME type | Description |
|---|---|---|
| cron://jobs/{id} | application/json | Full normalized job document plus computed scheduler state. |
| cron://runs/{id} | application/json | Run record plus log resource links. |
| cron://runs/{id}/log | text/plain; charset=utf-8 | Bounded run log; subscribable for live updates. |
| cron://schemas/job | application/schema+json | Current v3 job schema. |
| cron://schemas/tool-catalog | application/json | Machine-readable tool catalog for schema drift tests. |

### Prompts

| Prompt | Purpose | Arguments |
|---|---|---|
| `create-daily-summary-job` | Create a bounded daily summary job | time, timezone, runtime, outputPath |
| `investigate-failed-run` | Analyze run failure using logs/resources | runId |
| `harden-job-safety` | Review a job draft for schedule/path/script safety | jobDraft |
| `export-and-restore-plan` | Plan backup and restore workflow | destinationPath |
| `create-temporary-watch-job` | Create a bounded temporary recurring watcher | query, interval, duration |

## 4. Authentication & security

Local stdio mode has no auth. The host launches `cron mcp` as the interactive OS user; stdout is reserved for JSON-RPC and stderr for logs.

HTTP MCP requires a bearer token stored in `~/.cron/token` with mode `0600` or Windows owner-only ACL. The daemon auto-provisions it on start and `cron token rotate` atomically replaces it and invalidates HTTP sessions.

Every write tool must be tagged `dangerous: true` in MCP metadata and require `x_cron_confirm: true` in arguments. The metadata helps hosts show confirmation UI; the argument blocks silent automation.

Rate limit per client identity with sliding windows: run_now 5/5m, updates 20/10m, deletes/imports 5/10m, restart/shutdown 1/minute. Return `RATE_LIMITED` and retry-after seconds.

Sanitize script bodies. Reject `curl ... | sh`, `wget ... | bash`, `Invoke-WebRequest ... | iex`, `iwr ... | iex`, base64 PowerShell launchers, and download-and-execute patterns unless a local admin policy equivalent to `--i-know-what-im-doing` is configured. Do not expose that override casually as an LLM flag.

Enforce path allowlists for `cwd`, `allowedDirs`, attachments, scriptPath, import/export, and output paths. Resolve real paths, block traversal and symlink escapes, and deny UNC paths unless explicitly configured.

| Threat | Example | Impact | Mitigation |
|---|---|---|---|
| Prompt injection persistence | Web content asks model to schedule exfiltration | Credential theft | confirm flags, previews, sanitizer, allowlist |
| High-frequency spend loop | `every 1s` Copilot job | AI cost/CPU burn | validate min interval, budgets, rate limits |
| Destructive delete/import | Injected request deletes jobs | data loss | confirmation, dry-run, no wildcard delete |
| HTTP token theft | DNS rebinding to loopback | unauthorized control | 127.0.0.1 bind, Origin validation, bearer, rotate |
| Path escape | Output outside allowed roots | data exposure/corruption | realpath + roots + allowedDirs |
| Log leakage | Inline full logs with tokens | secret exposure | bounded resources, redaction, no default log export |

## 5. Copilot skill design

The migrated Copilot skill is small and tells the model to use MCP tools only. Target: `~/.copilot/skills/cron/SKILL.md`.

### Full text of new `SKILL.md`

```markdown
---
name: cron
description: Natural-language helper for the standalone cron MCP server.
---

# cron — MCP scheduling skill

Use this skill when the user asks to create, inspect, edit, run, debug, import, export, migrate, or manage scheduled Copilot/Agency/script jobs.
The old `/cron-job` slash command is removed. Do not call it. Do not edit cron files directly. Use the registered `cron` MCP server.

## Capabilities

- Create bounded cron, interval, and one-shot jobs.
- List, inspect, update, enable, disable, delete, and run jobs.
- Validate and preview schedules before mutation.
- Read run history and logs through resources.
- Open dashboard, export/import, migrate legacy state, diagnose daemon/autostart/token issues.

## Tool reference

- `cron_job_create`
- `cron_job_list`
- `cron_job_get`
- `cron_job_update`
- `cron_job_delete`
- `cron_job_enable`
- `cron_job_disable`
- `cron_job_run_now`
- `cron_job_cancel_run`
- `cron_run_list`
- `cron_run_get`
- `cron_run_logs`
- `cron_schedule_preview`
- `cron_schedule_validate`
- `cron_stats_summary`
- `cron_stats_job`
- `cron_daemon_status`
- `cron_daemon_reload`
- `cron_daemon_restart`
- `cron_daemon_shutdown`
- `cron_autostart_status`
- `cron_autostart_install`
- `cron_autostart_remove`
- `cron_export`
- `cron_import`
- `cron_dashboard_open`
- `cron_migrate_from_copilot_ext`
- `cron_doctor`

## Decision tree

- **Create/schedule/add:** validate -> preview -> concise preview -> confirm -> create -> verify get -> report job id.
- **Edit/reschedule:** get -> minimal patch -> validate/preview if schedule changes -> confirm -> update.
- **Pause/stop future runs:** prefer disable, confirm, cite job id.
- **Resume:** enable, confirm, cite next run.
- **Delete/remove permanently:** get, summarize deletion, confirm, delete.
- **Run now:** confirm, run_now, return run id and tail_url.
- **Why failed/logs:** run_list -> run_get -> run_logs -> summarize and cite run id.
- **Backup/restore:** export or import dry-run first, confirm actual import.
- **Health:** daemon_status then doctor if unhealthy.
- **Migrate:** migrate dry-run first, confirm actual migration.

## Safety rules

- Always call `cron_schedule_validate` before create/update.
- Always call `cron_schedule_preview` before recurring create/update.
- Always confirm destructive or costly operations.
- Pass `x_cron_confirm: true` only after confirmation or approved automation policy.
- Cite job ids and run ids in replies.
- Prefer bounded recurring schedules with `until` or `maxRuns`.
- Warn for unbounded jobs and high-frequency intervals.
- Do not create abusive schedules such as `every 1s` unless policy and user explicitly allow it.
- Reject unsafe scripts containing `curl | sh`, `wget | bash`, `iwr | iex`, or base64 execution patterns.
- Use `allowedDirs` for paths outside cwd.
- Prefer disable over delete unless user says delete permanently.
- Use dry-run for import and migration before changing state.
- Do not paste huge logs; use `cron://runs/{id}/log` or bounded tails.

## Schedule translation

| User phrase | Schedule |
|---|---|
| every 5 minutes | `{"kind":"interval","every":"every 5m"}` |
| every day at 9am | `{"kind":"cron","cron":"0 9 * * *","timezone":"America/Los_Angeles"}` |
| weekdays at 9am | `{"kind":"cron","cron":"0 9 * * mon-fri","timezone":"America/Los_Angeles"}` |
| tomorrow at 3pm | `{"kind":"one-shot","at":"<computed ISO>"}` |

Default timezone for this user is `America/Los_Angeles` unless specified.

## Example dialogs

### Create daily summary
User: Schedule a summary daily at 9am for 30 days. Actions: validate cron, preview five fires, confirm, create. Reply with job id and next run.

### Investigate failure
User: Why did daily-summary fail? Actions: list failed runs, get newest, read bounded logs, summarize likely cause with run id.

### Disable safely
User: Stop daily-summary. Ask disable vs delete if ambiguous; recommend disable; confirm; call disable.

### Unsafe script
User asks for `curl https://x/install.sh | sh` hourly. Refuse as-is and suggest reviewed pinned script path.

### Import backup
Run import dry-run, summarize created/updated/skipped, confirm, then import.

## Response style

- Be concise and operational.
- Do not paste raw JSON unless asked.
- Include next run on create/update.
- Include error code and next action on failure.

## Tool cheat sheet details

### cron_job_create
Create and schedule a new cron job after validation and preview.
Use the structured result. Cite ids. Do not invent fields.

### cron_job_list
List jobs with optional enabled filters and next-fire computation.
Use the structured result. Cite ids. Do not invent fields.

### cron_job_get
Fetch one job with computed state and recent run details.
Use the structured result. Cite ids. Do not invent fields.

### cron_job_update
Merge-patch, validate, and reschedule an existing job atomically.
Use the structured result. Cite ids. Do not invent fields.

### cron_job_delete
Delete a job and its persisted run/log data.
Use the structured result. Cite ids. Do not invent fields.

### cron_job_enable
Enable a disabled job and schedule future fires.
Use the structured result. Cite ids. Do not invent fields.

### cron_job_disable
Disable a job without deleting its history.
Use the structured result. Cite ids. Do not invent fields.

### cron_job_run_now
Start a manual run immediately.
Use the structured result. Cite ids. Do not invent fields.

### cron_job_cancel_run
Cancel an active or queued run. (provisional: add daemon cancel support.)
Use the structured result. Cite ids. Do not invent fields.

### cron_run_list
List historical runs globally or for one job.
Use the structured result. Cite ids. Do not invent fields.

### cron_run_get
Fetch a single run record.
Use the structured result. Cite ids. Do not invent fields.

### cron_run_logs
Return bounded log tail plus `tail_url` and log resource link.
Use the structured result. Cite ids. Do not invent fields.

### cron_schedule_preview
Compute next N fires for cron/interval/one-shot schedules, DST-aware.
Use the structured result. Cite ids. Do not invent fields.

### cron_schedule_validate
Validate syntax and semantics; catch high-frequency abuse.
Use the structured result. Cite ids. Do not invent fields.

### cron_stats_summary
Return aggregate run statistics.
Use the structured result. Cite ids. Do not invent fields.

### cron_stats_job
Return run statistics for one job.
Use the structured result. Cite ids. Do not invent fields.

### cron_daemon_status
Check daemon health, PID, version, queues, and MCP endpoint.
Use the structured result. Cite ids. Do not invent fields.

### cron_daemon_reload
Reload job files and reschedule valid jobs.
Use the structured result. Cite ids. Do not invent fields.

### cron_daemon_restart
Restart daemon and wait for health. (provisional supervisor feature.)
Use the structured result. Cite ids. Do not invent fields.

### cron_daemon_shutdown
Ask daemon to stop after responding.
Use the structured result. Cite ids. Do not invent fields.

### cron_autostart_status
Report login autostart and watchdog status.
Use the structured result. Cite ids. Do not invent fields.

### cron_autostart_install
Install per-user daemon autostart and optional watchdog.
Use the structured result. Cite ids. Do not invent fields.

### cron_autostart_remove
Remove per-user daemon autostart and optional watchdog.
Use the structured result. Cite ids. Do not invent fields.

### cron_export
Export jobs and optional run metadata to portable JSON.
Use the structured result. Cite ids. Do not invent fields.

### cron_import
Import a backup with dry-run, merge, or replace mode.
Use the structured result. Cite ids. Do not invent fields.

### cron_dashboard_open
Open dashboard or return its URL.
Use the structured result. Cite ids. Do not invent fields.

### cron_migrate_from_copilot_ext
Migrate from legacy Copilot extension cron roots. (provisional.)
Use the structured result. Cite ids. Do not invent fields.

### cron_doctor
Run diagnostics and optionally fix stale local state.
Use the structured result. Cite ids. Do not invent fields.

```

## 6. Registration for popular MCP hosts

### Copilot CLI stdio (`~/.copilot/mcp-config.json`)

```json
{"mcpServers":{"cron":{"tools":["*"],"type":"stdio","command":"cron","args":["mcp"]}}}
```

### Copilot CLI HTTP

```json
{"mcpServers":{"cron":{"tools":["*"],"type":"http","url":"http://127.0.0.1:53127/mcp","headers":{"Authorization":"Bearer ${CRON_MCP_TOKEN}"}}}}
```

### Claude Desktop stdio

```json
{"mcpServers":{"cron":{"command":"cron","args":["mcp"]}}}
```

### Claude Desktop HTTP

```json
{"mcpServers":{"cron":{"transport":"http","url":"http://127.0.0.1:53127/mcp","headers":{"Authorization":"Bearer ${CRON_MCP_TOKEN}"}}}}
```

### Cursor stdio (`~/.cursor/mcp.json`)

```json
{"mcpServers":{"cron":{"command":"cron","args":["mcp"]}}}
```

### Cursor HTTP

```json
{"mcpServers":{"cron":{"type":"http","url":"http://127.0.0.1:53127/mcp","headers":{"Authorization":"Bearer ${CRON_MCP_TOKEN}"}}}}
```

### Continue stdio (`~/.continue/config.json`)

```json
{"mcpServers":[{"name":"cron","command":"cron","args":["mcp"]}]}
```

### Continue HTTP

```json
{"mcpServers":[{"name":"cron","transport":"http","url":"http://127.0.0.1:53127/mcp","headers":{"Authorization":"Bearer ${CRON_MCP_TOKEN}"}}]}
```

### Cline / RooCode stdio

```json
{"mcpServers":{"cron":{"command":"cron","args":["mcp"],"disabled":false,"autoApprove":[]}}}
```

### Cline / RooCode HTTP

```json
{"mcpServers":{"cron":{"transportType":"streamableHttp","url":"http://127.0.0.1:53127/mcp","headers":{"Authorization":"Bearer ${CRON_MCP_TOKEN}"},"disabled":false,"autoApprove":[]}}}
```

### Zed stdio

```json
{"context_servers":{"cron":{"command":{"path":"cron","args":["mcp"]}}}}
```

### Zed HTTP

```json
{"context_servers":{"cron":{"source":"custom","transport":{"type":"http","url":"http://127.0.0.1:53127/mcp","headers":{"Authorization":"Bearer ${CRON_MCP_TOKEN}"}}}}}
```

## 7. Testing MCP

### Contract tests

- Use MCP SDK client to launch `cron mcp`, initialize, list tools, and call each tool end-to-end against isolated `CRON_ROOT`.
- Run HTTP Streamable tests against daemon `/mcp` with bearer token and session id.
- Assert writes fail without `x_cron_confirm` and `dangerous`.

### Golden JSON-schema tests

- Snapshot input/output schemas and annotations.
- Validate every example call/response in this document.
- Fail if object schemas omit `additionalProperties: false`.

### Fuzz schedule validation

- Fuzz cron field counts/ranges/names/timezones/DST.
- Fuzz intervals around 0s/1s/59s/60s/30d/31d and malformed units.
- Fuzz one-shot past/future/invalid/ambiguous local times.

### Compatibility tests

- Smoke test Copilot CLI and Cursor or Claude Desktop.
- Test HTTP auth, Origin rejection, token rotation, and protocol-version header.
- Test resource subscriptions for log updates with throttling.

## 8. Open questions

- Is `cron` available as the npm package name, or should the package be scoped while the binary remains `cron`?
- Should state root be `~/.cron`, XDG config, or configurable only?
- Which SDK generation is target at implementation time?
- Should cancel and restart be GA or provisional?
- Should all LLM-created recurring jobs require bounds?
- How should HTTP hosts read bearer token without copying it into synced JSON?
- What default roots are allowed when MCP client roots are absent?
- Should export include logs by default?
- How long should legacy SSE compatibility remain?
- Should migration leave a sentinel in the old Copilot extension root?
- What redaction policy applies to log resources?
- How to test Windows owner-only ACL as mode-600 equivalent?

## Appendix A. Common schema fragments

### `schedule`
```json
{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["cron","interval","one-shot"]},"cron":{"type":"string","pattern":"^\\S+(\\s+\\S+){4,5}$"},"timezone":{"type":"string","minLength":1},"every":{"type":"string","pattern":"^every (\\d+)(s|m|h|d)$"},"at":{"type":"string","format":"date-time"},"jitterSec":{"type":"integer","minimum":0,"maximum":3600,"default":0},"until":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"maxRuns":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"cron"}},"required":["kind"]},"then":{"required":["cron","timezone"],"not":{"anyOf":[{"required":["every"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"interval"}},"required":["kind"]},"then":{"required":["every"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"one-shot"}},"required":["kind"]},"then":{"required":["at"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["every"]},{"required":["until"]}]}}}]}
```

### `action`
```json
{"type":"object","additionalProperties":false,"required":["kind","runtime","timeoutSec"],"properties":{"kind":{"type":"string","enum":["copilot-prompt","script"]},"runtime":{"type":"string","enum":["copilot","agency","script"]},"prompt":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"cwd":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"timeoutSec":{"type":"integer","minimum":1,"maximum":86400},"agent":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"allowAllTools":{"type":"boolean","default":false},"availableTools":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"allowedDirs":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"attachments":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"resumeSessionId":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"sharedSession":{"type":"boolean","default":false},"script":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"shell":{"type":"string","enum":["powershell","cmd","bash","node","auto"],"default":"auto"},"scriptPath":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"copilot-prompt"}},"required":["kind"]},"then":{"properties":{"prompt":{"type":"string","minLength":1}},"required":["prompt"]}},{"if":{"properties":{"kind":{"const":"script"}},"required":["kind"]},"then":{"anyOf":[{"properties":{"script":{"type":"string","minLength":1}},"required":["script"]},{"properties":{"scriptPath":{"type":"string","minLength":1}},"required":["scriptPath"]}]}}]}
```

### `output`
```json
{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["stdout-only","file"]},"path":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"appendRunLog":{"type":"boolean","default":false}},"allOf":[{"if":{"properties":{"kind":{"const":"file"}},"required":["kind"]},"then":{"properties":{"path":{"type":"string","minLength":1}},"required":["path"]}}]}
```

### `retry`
```json
{"type":"object","additionalProperties":false,"required":["maxAttempts","backoffSec"],"properties":{"maxAttempts":{"type":"integer","minimum":0,"maximum":5},"backoffSec":{"type":"integer","minimum":0,"maximum":86400}}}
```

### `budgets`
```json
{"type":"object","additionalProperties":false,"required":["maxRunsPerDay","maxTokensPerRun"],"properties":{"maxRunsPerDay":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}]},"maxTokensPerRun":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}]}}}
```

### `job`
```json
{"type":"object","additionalProperties":false,"required":["$schemaVersion","id","description","enabled","createdAt","updatedAt","catchup","overlap","schedule","action","output","retry","budgets"],"properties":{"$schemaVersion":{"type":"integer","const":3},"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"description":{"type":"string"},"enabled":{"type":"boolean"},"createdAt":{"type":"string","format":"date-time"},"updatedAt":{"type":"string","format":"date-time"},"catchup":{"type":"string","enum":["run-once","run-all","skip"]},"overlap":{"type":"string","enum":["skip","queue","cancel-previous"]},"schedule":{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["cron","interval","one-shot"]},"cron":{"type":"string","pattern":"^\\S+(\\s+\\S+){4,5}$"},"timezone":{"type":"string","minLength":1},"every":{"type":"string","pattern":"^every (\\d+)(s|m|h|d)$"},"at":{"type":"string","format":"date-time"},"jitterSec":{"type":"integer","minimum":0,"maximum":3600,"default":0},"until":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"maxRuns":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"cron"}},"required":["kind"]},"then":{"required":["cron","timezone"],"not":{"anyOf":[{"required":["every"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"interval"}},"required":["kind"]},"then":{"required":["every"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["at"]}]}}},{"if":{"properties":{"kind":{"const":"one-shot"}},"required":["kind"]},"then":{"required":["at"],"not":{"anyOf":[{"required":["cron"]},{"required":["timezone"]},{"required":["every"]},{"required":["until"]}]}}}]},"action":{"type":"object","additionalProperties":false,"required":["kind","runtime","timeoutSec"],"properties":{"kind":{"type":"string","enum":["copilot-prompt","script"]},"runtime":{"type":"string","enum":["copilot","agency","script"]},"prompt":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"cwd":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"timeoutSec":{"type":"integer","minimum":1,"maximum":86400},"agent":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"allowAllTools":{"type":"boolean","default":false},"availableTools":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"allowedDirs":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"attachments":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},{"type":"null"}],"default":null},"resumeSessionId":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"sharedSession":{"type":"boolean","default":false},"script":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"shell":{"type":"string","enum":["powershell","cmd","bash","node","auto"],"default":"auto"},"scriptPath":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null}},"allOf":[{"if":{"properties":{"kind":{"const":"copilot-prompt"}},"required":["kind"]},"then":{"properties":{"prompt":{"type":"string","minLength":1}},"required":["prompt"]}},{"if":{"properties":{"kind":{"const":"script"}},"required":["kind"]},"then":{"anyOf":[{"properties":{"script":{"type":"string","minLength":1}},"required":["script"]},{"properties":{"scriptPath":{"type":"string","minLength":1}},"required":["scriptPath"]}]}}]},"output":{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":["stdout-only","file"]},"path":{"anyOf":[{"type":"string","minLength":1},{"type":"null"}],"default":null},"appendRunLog":{"type":"boolean","default":false}},"allOf":[{"if":{"properties":{"kind":{"const":"file"}},"required":["kind"]},"then":{"properties":{"path":{"type":"string","minLength":1}},"required":["path"]}}]},"retry":{"type":"object","additionalProperties":false,"required":["maxAttempts","backoffSec"],"properties":{"maxAttempts":{"type":"integer","minimum":0,"maximum":5},"backoffSec":{"type":"integer","minimum":0,"maximum":86400}}},"budgets":{"type":"object","additionalProperties":false,"required":["maxRunsPerDay","maxTokensPerRun"],"properties":{"maxRunsPerDay":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}]},"maxTokensPerRun":{"anyOf":[{"type":"integer","minimum":1},{"type":"null"}]}}}}}
```

### `run`
```json
{"type":"object","additionalProperties":false,"required":["runId","jobId","status","trigger","startedAt"],"properties":{"runId":{"type":"string","minLength":1,"description":"Run id."},"jobId":{"type":"string","pattern":"^[a-z][a-z0-9-]{1,63}$","description":"Stable job id."},"status":{"type":"string","enum":["queued","running","success","failure","timeout","skipped","cancelled","missed"]},"trigger":{"type":"string","enum":["scheduled","manual","retry","catchup","system"]},"startedAt":{"type":"string","format":"date-time"},"endedAt":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"exitCode":{"anyOf":[{"type":"integer"},{"type":"null"}],"default":null},"durationMs":{"anyOf":[{"type":"integer","minimum":0},{"type":"null"}],"default":null},"logPath":{"anyOf":[{"type":"string"},{"type":"null"}],"default":null},"error":{"anyOf":[{"type":"string"},{"type":"null"}],"default":null},"sessionId":{"anyOf":[{"type":"string"},{"type":"null"}],"default":null}}}
```
