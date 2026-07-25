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
  { capability: 'daemon-status', clientMethod: 'daemonStatus', cliCommand: ['daemon', 'status'], mcpTool: 'crontick_daemon_status' },
  { capability: 'daemon-reload', clientMethod: 'daemonReload', cliCommand: ['daemon', 'reload'], mcpTool: 'crontick_daemon_reload' },
  { capability: 'daemon-restart', clientMethod: 'daemonRestart', cliCommand: ['daemon', 'restart'], mcpTool: 'crontick_daemon_restart' },
  { capability: 'doctor', clientMethod: 'doctor', cliCommand: ['doctor'], mcpTool: 'crontick_doctor' },
  { capability: 'dashboard', clientMethod: 'dashboardUrl', cliCommand: ['dashboard'], mcpTool: 'crontick_dashboard_open' },
] as const satisfies readonly SurfaceCapability[];

export const CLIENT_METHODS = SURFACE_CAPABILITIES.map((capability) => capability.clientMethod);
export const MCP_TOOLS = SURFACE_CAPABILITIES.map((capability) => capability.mcpTool);
