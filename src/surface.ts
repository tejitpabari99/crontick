/**
 * Canonical mapping of every user-facing operation to its expression across the
 * CLI, MCP, and library surfaces. Adding a capability here requires a matching
 * CrontickClient method, a Commander subcommand in cli/index.ts, a registerTool
 * call in mcp/index.ts, and (if new types are needed) an export in index.ts.
 *
 * tests/unit/surface-drift.test.ts asserts all four columns stay in sync — it will
 * fail if any surface drifts from this table.
 */

export interface SurfaceCapability {
  capability: string;
  clientMethod: string;
  cliCommand: string[];
  mcpTool: string;
  optionNames?: readonly string[];
}

export const SURFACE_CAPABILITIES = [
  { capability: 'create-job', clientMethod: 'createJob', cliCommand: ['jobs', 'new'], mcpTool: 'crontick_job_create', optionNames: ['force', 'trustFolder'] },
  { capability: 'list-jobs', clientMethod: 'listJobs', cliCommand: ['jobs', 'list'], mcpTool: 'crontick_job_list' },
  { capability: 'get-job', clientMethod: 'getJob', cliCommand: ['jobs', 'get'], mcpTool: 'crontick_job_get' },
  { capability: 'update-job', clientMethod: 'updateJob', cliCommand: ['jobs', 'update'], mcpTool: 'crontick_job_update', optionNames: ['trustFolder'] },
  { capability: 'enable-job', clientMethod: 'enableJob', cliCommand: ['jobs', 'update'], mcpTool: 'crontick_job_enable', optionNames: ['enable'] },
  { capability: 'disable-job', clientMethod: 'disableJob', cliCommand: ['jobs', 'update'], mcpTool: 'crontick_job_disable', optionNames: ['disable'] },
  { capability: 'delete-job', clientMethod: 'deleteJob', cliCommand: ['jobs', 'delete'], mcpTool: 'crontick_job_delete' },
  { capability: 'run-now', clientMethod: 'runNow', cliCommand: ['jobs', 'run-now'], mcpTool: 'crontick_job_run_now' },
  { capability: 'job-schedule', clientMethod: 'jobSchedule', cliCommand: ['jobs', 'schedule'], mcpTool: 'crontick_job_schedule' },
  { capability: 'cancel-run', clientMethod: 'cancelRun', cliCommand: ['runs', 'cancel'], mcpTool: 'crontick_job_cancel_run' },
  { capability: 'list-runs', clientMethod: 'listRuns', cliCommand: ['runs', 'list'], mcpTool: 'crontick_run_list' },
  { capability: 'get-run', clientMethod: 'getRun', cliCommand: ['runs', 'get'], mcpTool: 'crontick_run_get' },
  { capability: 'logs', clientMethod: 'getLogs', cliCommand: ['runs', 'logs'], mcpTool: 'crontick_run_logs_tail' },
  { capability: 'run-output', clientMethod: 'getOutput', cliCommand: ['runs', 'output'], mcpTool: 'crontick_run_output' },
  { capability: 'stats-summary', clientMethod: 'statsSummary', cliCommand: ['stats', 'summary'], mcpTool: 'crontick_stats_summary' },
  { capability: 'stats-job', clientMethod: 'statsJob', cliCommand: ['stats', 'job'], mcpTool: 'crontick_stats_job' },
  { capability: 'export', clientMethod: 'exportJobs', cliCommand: ['share', 'export'], mcpTool: 'crontick_export' },
  { capability: 'import', clientMethod: 'importJobs', cliCommand: ['share', 'import'], mcpTool: 'crontick_import' },
  { capability: 'daemon-stop', clientMethod: 'daemonStop', cliCommand: ['daemon', 'stop'], mcpTool: 'crontick_daemon_stop' },
  { capability: 'daemon-reload', clientMethod: 'daemonReload', cliCommand: ['daemon', 'reload'], mcpTool: 'crontick_daemon_reload' },
  { capability: 'doctor', clientMethod: 'doctor', cliCommand: ['doctor'], mcpTool: 'crontick_doctor' },
  { capability: 'info', clientMethod: 'info', cliCommand: ['info'], mcpTool: 'crontick_info' },
] as const satisfies readonly SurfaceCapability[];

/** All MCP tool names covered by the parity contract. */
export const MCP_TOOLS = SURFACE_CAPABILITIES.map((capability) => capability.mcpTool);
