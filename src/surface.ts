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
  /** Omitted only with an explicit `mcpExemption`. */
  mcpTool?: string;
  /** Deliberate surface-parity exception: why this capability is not exposed over MCP. */
  mcpExemption?: string;
  optionNames?: readonly string[];
}

export const SURFACE_CAPABILITIES = [
  { capability: 'create-job', clientMethod: 'createJob', cliCommand: ['jobs', 'new'], mcpTool: 'crontick_job_create', optionNames: ['force', 'trustFolder', 'webhook', 'relay', 'webhookSecret', 'catchUp'] },
  { capability: 'list-jobs', clientMethod: 'listJobs', cliCommand: ['jobs', 'list'], mcpTool: 'crontick_job_list' },
  { capability: 'get-job', clientMethod: 'getJob', cliCommand: ['jobs', 'get'], mcpTool: 'crontick_job_get' },
  { capability: 'update-job', clientMethod: 'updateJob', cliCommand: ['jobs', 'update'], mcpTool: 'crontick_job_update', optionNames: ['trustFolder', 'stopRunning', 'waitRunning', 'webhook', 'relay', 'webhookSecret', 'catchUp'] },
  { capability: 'enable-job', clientMethod: 'enableJob', cliCommand: ['jobs', 'update'], mcpTool: 'crontick_job_enable', optionNames: ['enable'] },
  { capability: 'disable-job', clientMethod: 'disableJob', cliCommand: ['jobs', 'update'], mcpTool: 'crontick_job_disable', optionNames: ['disable'] },
  { capability: 'delete-job', clientMethod: 'deleteJob', cliCommand: ['jobs', 'delete'], mcpTool: 'crontick_job_delete', optionNames: ['force'] },
  { capability: 'run-now', clientMethod: 'runNow', cliCommand: ['jobs', 'run-now'], mcpTool: 'crontick_job_run_now' },
  { capability: 'trigger-job', clientMethod: 'triggerJob', cliCommand: ['jobs', 'trigger'], mcpTool: 'crontick_job_trigger', optionNames: ['payload'] },
  { capability: 'job-schedule', clientMethod: 'jobSchedule', cliCommand: ['jobs', 'schedule'], mcpTool: 'crontick_job_schedule' },
  { capability: 'cancel-run', clientMethod: 'cancelRun', cliCommand: ['runs', 'cancel'], mcpTool: 'crontick_job_cancel_run' },
  { capability: 'list-runs', clientMethod: 'listRuns', cliCommand: ['runs', 'list'], mcpTool: 'crontick_run_list' },
  { capability: 'get-run', clientMethod: 'getRun', cliCommand: ['runs', 'get'], mcpTool: 'crontick_run_get' },
  { capability: 'delete-runs', clientMethod: 'deleteRuns', cliCommand: ['runs', 'delete'], mcpTool: 'crontick_run_delete' },
  { capability: 'stats-summary', clientMethod: 'statsSummary', cliCommand: ['stats', 'summary'], mcpTool: 'crontick_stats_summary' },
  { capability: 'stats-job', clientMethod: 'statsJob', cliCommand: ['stats', 'job'], mcpTool: 'crontick_stats_job' },
  { capability: 'export', clientMethod: 'exportJobs', cliCommand: ['share', 'export'], mcpTool: 'crontick_export', optionNames: ['onlyJobs', 'includeSecrets'] },
  { capability: 'import', clientMethod: 'importJobs', cliCommand: ['share', 'import'], mcpTool: 'crontick_import', optionNames: ['trustFolder', 'includeSecrets'] },
  { capability: 'daemon-stop', clientMethod: 'daemonStop', cliCommand: ['daemon', 'stop'], mcpTool: 'crontick_daemon_stop' },
  { capability: 'daemon-reload', clientMethod: 'daemonReload', cliCommand: ['daemon', 'reload'], mcpTool: 'crontick_daemon_reload' },
  { capability: 'daemon-pause', clientMethod: 'daemonPause', cliCommand: ['daemon', 'pause'], mcpTool: 'crontick_daemon_pause' },
  { capability: 'daemon-resume', clientMethod: 'daemonResume', cliCommand: ['daemon', 'resume'], mcpTool: 'crontick_daemon_resume' },
  { capability: 'config-list', clientMethod: 'configList', cliCommand: ['config', 'list'], mcpTool: 'crontick_config_list' },
  { capability: 'config-get', clientMethod: 'configGet', cliCommand: ['config', 'get'], mcpTool: 'crontick_config_get' },
  { capability: 'config-set', clientMethod: 'configSet', cliCommand: ['config', 'set'], mcpTool: 'crontick_config_set', optionNames: ['string', 'stopRunning', 'waitRunning'] },
  { capability: 'config-unset', clientMethod: 'configUnset', cliCommand: ['config', 'unset'], mcpTool: 'crontick_config_unset', optionNames: ['stopRunning', 'waitRunning'] },
  { capability: 'doctor', clientMethod: 'doctor', cliCommand: ['doctor'], mcpTool: 'crontick_doctor' },
  { capability: 'info', clientMethod: 'info', cliCommand: ['info'], mcpTool: 'crontick_info' },
  { capability: 'autostart-enable', clientMethod: 'autostartEnable', cliCommand: ['autostart', 'enable'], mcpExemption: 'An agent must not create login persistence (owner decision, ADR 0034).' },
  { capability: 'autostart-disable', clientMethod: 'autostartDisable', cliCommand: ['autostart', 'disable'], mcpExemption: 'Paired with autostart-enable; registration is managed by the user via the CLI/library only.' },
  { capability: 'autostart-status', clientMethod: 'autostartStatus', cliCommand: ['autostart', 'status'], mcpTool: 'crontick_autostart_status' },
] as const satisfies readonly SurfaceCapability[];

/** All MCP tool names covered by the parity contract. */
export const MCP_TOOLS: string[] = SURFACE_CAPABILITIES.flatMap((capability) =>
  'mcpTool' in capability ? [capability.mcpTool] : []);
