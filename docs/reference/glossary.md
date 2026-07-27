# Glossary

Short definitions of crontick terms.

| Term | Definition |
|------|------------|
| **job** | A named unit of scheduled work: an ID, a schedule, an action, and policies (overlap, retry). Persisted as `<dataDir>/jobs/<id>.json`. |
| **run** | A single execution instance of a job. Tracked in SQLite with status, timestamps, exit code, and logs. |
| **schedule** | The timing rule attached to a job. One of `cron`, `interval`, or `one-shot`. |
| **action** | What a job does when it fires. One of `script` (inline shell), `exec` (binary command), or `prompt` (LLM engine invocation). |
| **engine** | A configured command-line tool used to execute prompt actions (e.g., `copilot`). Defined in `config.json` under `engines`. |
| **surface** | One of the three public interfaces: CLI, MCP server, or library/package API. All surfaces are thin shims over `CrontickClient`. |
| **shim** | A thin adapter layer (CLI, MCP, or package export) that delegates to `CrontickClient` without adding proprietary logic. |
| **daemon** | A long-running background Node.js process that hosts the scheduler, runner, HTTP API, and SQLite store. Started on-demand. |
| **demand-start** | The pattern where the daemon is started automatically when a client operation needs it, rather than requiring manual startup. |
| **capability** | A named operation (e.g., `create-job`) that maps 1:1 across all three surfaces. Defined in `SURFACE_CAPABILITIES`. |
| **overlap policy** | Controls behavior when a job fires while a previous run is still active: `skip` (drop the new tick), `queue` (wait), or `cancel-previous` (abort the running execution). |
| **retry** | Automatic re-execution of a failed run up to `retry.max` times with `retry.backoffSec` delay between attempts. |
| **data directory** | The filesystem root where crontick stores all state: jobs, runs database, config, logs, PID/port files. |
| **config** | The `config.json` file in the data directory. Defines engines and `defaultEngine`. Falls back to built-in defaults if absent. |
| **client** | `CrontickClient` — the single core class through which all operations flow. Transport-agnostic. |
| **one-shot** | A schedule kind that fires exactly once at a specified ISO-8601 time. |
| **kebab-case** | The naming convention required for job IDs: lowercase letters, digits, and hyphens (`my-job-1`). |
| **WAL** | Write-Ahead Logging — the SQLite journal mode used by `runs.db` for concurrent read access while the daemon writes. |
| **prompt job** | A job whose action kind is `prompt`: it invokes a configured engine (CLI tool) with a text prompt and optional session. |
| **session** | An engine-side conversation context. `sessionId` fixes it; `reuseSession` captures and reuses the first successful one. |
| **notice** | A non-fatal advisory message collected during an operation (e.g., "reuseSession was ignored because an explicit sessionId was provided"). |
| **doctor** | A built-in health-check command that verifies Node.js version, SQLite, data directory, daemon, dashboard, and MCP server. |
| **dashboard** | A browser-based status UI served by the daemon. Shows job list, run history, stats, and health. |
