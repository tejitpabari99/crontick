'use strict';

async function loadDashboard() {
  const runsLimit = document.getElementById('runs-limit')?.value || '100';
  const jobId = document.getElementById('job-filter')?.value || '';
  const qs = new URLSearchParams({ runsLimit });
  if (jobId) qs.set('jobId', jobId);
  const res = await fetch(`/api/dashboard?${qs}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Dashboard data request failed');
  renderDashboard(data);
}

function renderDashboard(data) {
  renderHealth(data.health);
  renderSummary(data.stats);
  renderJobs(data.jobs || []);
  renderRuns(data.runs || []);
}

function renderHealth(health) {
  const badge = document.getElementById('health-badge');
  const versionEl = document.getElementById('version-info');
  badge.textContent = `✓ up ${formatUptime(health.uptimeSec)}`;
  badge.className = 'badge badge-ok';
  versionEl.textContent = `v${health.version} · pid ${health.pid} · node ${health.node} · ${health.jobs.total} jobs`;
}

function renderSummary(stats) {
  document.getElementById('summary').innerHTML = `
    <div class="card"><strong>${escHtml(stats.enabledJobs)}/${escHtml(stats.totalJobs)}</strong><span>jobs enabled</span></div>
    <div class="card"><strong>${escHtml(stats.totalRuns)}</strong><span>runs</span></div>
    <div class="card"><strong>${escHtml(stats.failed)}</strong><span>failed</span></div>
    <div class="card"><strong>${stats.avgDurationMs == null ? '—' : escHtml(stats.avgDurationMs + 'ms')}</strong><span>avg duration</span></div>
  `;
}

function renderJobs(jobs) {
  const tbody = document.getElementById('jobs-tbody');
  tbody.innerHTML = jobs.length === 0 ? emptyRow(7, 'No jobs') : jobs.map((job) => `
    <tr>
      <td><code>${escHtml(job.id)}</code></td>
      <td>${escHtml(job.description || '—')}</td>
      <td><code>${escHtml(job.scheduleLabel)}</code></td>
      <td>${escHtml(job.actionKind)}</td>
      <td>${job.enabled ? 'yes' : 'no'}</td>
      <td class="status-${escHtml(job.lastStatus || 'queued')}">${escHtml(job.lastStatus || '—')}</td>
      <td>${job.nextRunAt ? escHtml(new Date(job.nextRunAt).toLocaleString()) : '—'}</td>
    </tr>
  `).join('');
}

function renderRuns(runs) {
  const tbody = document.getElementById('runs-tbody');
  tbody.innerHTML = runs.length === 0 ? emptyRow(5, 'No runs') : runs.map((run) => `
    <tr>
      <td><code>${escHtml(run.id.slice(0, 12))}${run.id.length > 12 ? '…' : ''}</code></td>
      <td>${escHtml(run.jobId)}</td>
      <td class="status-${escHtml(run.status)}">${escHtml(run.status)}</td>
      <td>${escHtml(new Date(run.startedAt).toLocaleString())}</td>
      <td>${run.durationMs == null ? '—' : escHtml(run.durationMs + 'ms')}</td>
    </tr>
  `).join('');
}

function emptyRow(cols, message) {
  return `<tr><td colspan="${cols}" class="muted">${escHtml(message)}</td></tr>`;
}

function formatUptime(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

document.getElementById('btn-refresh').addEventListener('click', () => void loadDashboard());
document.getElementById('runs-limit').addEventListener('change', () => void loadDashboard());
document.getElementById('job-filter').addEventListener('change', () => void loadDashboard());

loadDashboard().catch((err) => {
  const badge = document.getElementById('health-badge');
  badge.textContent = `✗ ${err.message}`;
  badge.className = 'badge badge-error';
});
