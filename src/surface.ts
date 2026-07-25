export interface SurfaceCapability {
  capability: string;
  clientMethod: string;
  cliCommand: string[];
  mcpTool: string;
}

export const SURFACE_CAPABILITIES = [
  { capability: 'create-job', clientMethod: 'createJob', cliCommand: ['new'], mcpTool: 'crontick_job_create' },
  { capability: 'list-jobs', clientMethod: 'listJobs', cliCommand: ['list'], mcpTool: 'crontick_job_list' },
  { capability: 'get-job', clientMethod: 'getJob', cliCommand: ['get'], mcpTool: 'crontick_job_get' },
  { capability: 'update-job', clientMethod: 'updateJob', cliCommand: ['update'], mcpTool: 'crontick_job_update' },
  { capability: 'delete-job', clientMethod: 'deleteJob', cliCommand: ['delete'], mcpTool: 'crontick_job_delete' },
  { capability: 'enable-job', clientMethod: 'enableJob', cliCommand: ['enable'], mcpTool: 'crontick_job_enable' },
  { capability: 'disable-job', clientMethod: 'disableJob', cliCommand: ['disable'], mcpTool: 'crontick_job_disable' },
  { capability: 'run-now', clientMethod: 'runNow', cliCommand: ['run-now'], mcpTool: 'crontick_job_run_now' },
  { capability: 'cancel-run', clientMethod: 'cancelRun', cliCommand: ['cancel-run'], mcpTool: 'crontick_job_cancel_run' },
  { capability: 'list-runs', clientMethod: 'listRuns', cliCommand: ['runs', 'list'], mcpTool: 'crontick_run_list' },
  { capability: 'get-run', clientMethod: 'getRun', cliCommand: ['runs', 'get'], mcpTool: 'crontick_run_get' },
  { capability: 'logs', clientMethod: 'getLogs', cliCommand: ['logs'], mcpTool: 'crontick_run_logs_tail' },
  { capability: 'schedule-validate', clientMethod: 'validateSchedule', cliCommand: ['schedule', 'validate'], mcpTool: 'crontick_schedule_validate' },
  { capability: 'schedule-preview', clientMethod: 'previewSchedule', cliCommand: ['schedule', 'preview'], mcpTool: 'crontick_schedule_preview' },
  { capability: 'stats-summary', clientMethod: 'statsSummary', cliCommand: ['stats', 'summary'], mcpTool: 'crontick_stats_summary' },
  { capability: 'stats-job', clientMethod: 'statsJob', cliCommand: ['stats', 'job'], mcpTool: 'crontick_stats_job' },
  { capability: 'export', clientMethod: 'exportJobs', cliCommand: ['export'], mcpTool: 'crontick_export' },
  { capability: 'import', clientMethod: 'importJobs', cliCommand: ['import'], mcpTool: 'crontick_import' },
  { capability: 'daemon-start', clientMethod: 'daemonStart', cliCommand: ['daemon', 'start'], mcpTool: 'crontick_daemon_start' },
  { capability: 'daemon-stop', clientMethod: 'daemonStop', cliCommand: ['daemon', 'stop'], mcpTool: 'crontick_daemon_stop' },
  { capability: 'daemon-status', clientMethod: 'daemonStatus', cliCommand: ['daemon', 'status'], mcpTool: 'crontick_daemon_status' },
  { capability: 'daemon-reload', clientMethod: 'daemonReload', cliCommand: ['daemon', 'reload'], mcpTool: 'crontick_daemon_reload' },
  { capability: 'daemon-restart', clientMethod: 'daemonRestart', cliCommand: ['daemon', 'restart'], mcpTool: 'crontick_daemon_restart' },
  { capability: 'doctor', clientMethod: 'doctor', cliCommand: ['doctor'], mcpTool: 'crontick_doctor' },
  { capability: 'dashboard-start', clientMethod: 'dashboardStart', cliCommand: ['dashboard', 'start'], mcpTool: 'crontick_dashboard_start' },
  { capability: 'dashboard-status', clientMethod: 'dashboardStatus', cliCommand: ['dashboard', 'status'], mcpTool: 'crontick_dashboard_status' },
  { capability: 'dashboard-data', clientMethod: 'dashboardData', cliCommand: ['dashboard', 'data'], mcpTool: 'crontick_dashboard_data' },
  { capability: 'dashboard-stop', clientMethod: 'dashboardStop', cliCommand: ['dashboard', 'stop'], mcpTool: 'crontick_dashboard_stop' },
  { capability: 'config-get', clientMethod: 'getConfigValue', cliCommand: ['config', 'get'], mcpTool: 'crontick_config_get' },
  { capability: 'config-set', clientMethod: 'setConfigValue', cliCommand: ['config', 'set'], mcpTool: 'crontick_config_set' },
  { capability: 'config-unset', clientMethod: 'removeConfigValue', cliCommand: ['config', 'unset'], mcpTool: 'crontick_config_unset' },
  { capability: 'config-engine-list', clientMethod: 'listEngines', cliCommand: ['config', 'engines'], mcpTool: 'crontick_config_engine_list' },
  { capability: 'config-engine-add', clientMethod: 'addEngine', cliCommand: ['config', 'engines', 'add'], mcpTool: 'crontick_config_engine_add' },
  { capability: 'config-engine-update', clientMethod: 'updateEngine', cliCommand: ['config', 'engines', 'update'], mcpTool: 'crontick_config_engine_update' },
  { capability: 'config-engine-remove', clientMethod: 'removeEngine', cliCommand: ['config', 'engines', 'remove'], mcpTool: 'crontick_config_engine_remove' },
  { capability: 'config-init', clientMethod: 'initConfig', cliCommand: ['config', 'init'], mcpTool: 'crontick_config_init' },
  { capability: 'config-validate', clientMethod: 'validateConfig', cliCommand: ['config', 'validate'], mcpTool: 'crontick_config_validate' },
] as const satisfies readonly SurfaceCapability[];

export const CLIENT_METHODS = SURFACE_CAPABILITIES.map((capability) => capability.clientMethod);
export const MCP_TOOLS = SURFACE_CAPABILITIES.map((capability) => capability.mcpTool);
