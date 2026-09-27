'use strict';

let lastData = null;

async function loadDashboard() {
  const runsLimit = document.getElementById('runs-limit')?.value || '100';
  const jobId = document.getElementById('filter-job')?.value || '';
  const qs = new URLSearchParams({ runsLimit });
  if (jobId) qs.set('jobId', jobId);
  let res;
  let data;
  try {
    res = await fetch(`/api/dashboard?${qs}`);
    data = await res.json();
  } catch (err) {
    throw new Error(err?.message || 'Dashboard data request failed');
  }
  if (!res.ok) throw new Error(data?.error?.message || 'Dashboard data request failed');
  clearInlineError();
  lastData = data;
  renderDashboard(data);
}

function renderDashboard(data) {
  renderHealth(data.health);
  renderSummary(data.stats);
  renderJobs(data.jobs || []);
  renderJobFilter(data.jobs || []);
  renderRuns(data.runs || []);
}

function renderHealth(health) {
  const badge = document.getElementById('health-badge');
  const versionEl = document.getElementById('version-info');
  badge.textContent = `✓ up ${formatUptime(health.uptimeSec)}`;
  badge.className = 'badge badge-ok';
  badge.title = 'daemon uptime';
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

function shortId(id) {
  return id && id.length > 12 ? id.slice(0, 12) + '…' : (id || '');
}

function copyIcon(value) {
  if (value == null || value === '') return '';
  return `<button class="icon-btn copy-btn" title="Copy" data-copy="${escHtml(value)}">📋</button>`;
}

function renderJobs(jobs) {
  const tbody = document.getElementById('jobs-tbody');
  tbody.innerHTML = jobs.length === 0 ? emptyRow(8, 'No jobs') : jobs.map((job) => {
    const toggle = job.enabled
      ? `<button class="icon-btn action-btn" data-action="disable" data-id="${escHtml(job.id)}" title="Disable job">⏹</button>`
      : `<button class="icon-btn action-btn" data-action="enable" data-id="${escHtml(job.id)}" title="Enable job">▶</button>`;
    return `
    <tr class="job-row" data-id="${escHtml(job.id)}">
      <td>${escHtml(job.alias || '—')}</td>
      <td class="id-cell"><code title="${escHtml(job.id)}">${escHtml(shortId(job.id))}</code>${copyIcon(job.id)}</td>
      <td>${escHtml(job.description || '—')}</td>
      <td><code>${escHtml(job.scheduleLabel)}</code></td>
      <td>${escHtml(job.actionKind)}</td>
      <td class="status-${escHtml(job.lastStatus || 'queued')}">${escHtml(job.lastStatus || '—')}</td>
      <td>${job.nextRunAt ? escHtml(new Date(job.nextRunAt).toLocaleString()) : '—'}</td>
      <td class="actions-cell">
        ${toggle}
        <button class="icon-btn action-btn" data-action="delete" data-id="${escHtml(job.id)}" title="Delete job">🗑</button>
      </td>
    </tr>
  `;
  }).join('');
}

function renderJobFilter(jobs) {
  const select = document.getElementById('filter-job');
  const current = select.value;
  const options = ['<option value="">All jobs</option>']
    .concat(jobs.map((job) => `<option value="${escHtml(job.id)}">${escHtml(job.alias || shortId(job.id))}</option>`));
  select.innerHTML = options.join('');
  if ([...select.options].some((o) => o.value === current)) select.value = current;
}

function filteredSortedRuns(runs) {
  const statusFilter = document.getElementById('filter-status')?.value || '';
  const sort = document.getElementById('sort-runs')?.value || 'started-desc';
  let out = runs.slice();
  if (statusFilter) out = out.filter((r) => r.status === statusFilter);
  const [field, dir] = sort.split('-');
  const mul = dir === 'asc' ? 1 : -1;
  out.sort((a, b) => {
    const av = field === 'duration' ? (a.durationMs ?? 0) : a.startedAt;
    const bv = field === 'duration' ? (b.durationMs ?? 0) : b.startedAt;
    return (av - bv) * mul;
  });
  return out;
}

function renderRuns(runs) {
  const tbody = document.getElementById('runs-tbody');
  const rows = filteredSortedRuns(runs);
  tbody.innerHTML = rows.length === 0 ? emptyRow(6, 'No runs') : rows.map((run) => `
    <tr class="run-row" data-id="${escHtml(run.id)}">
      <td class="id-cell"><code title="${escHtml(run.id)}">${escHtml(run.id)}</code>${copyIcon(run.id)}</td>
      <td class="id-cell">${run.sessionId ? `<code title="${escHtml(run.sessionId)}">${escHtml(run.sessionId)}</code>${copyIcon(run.sessionId)}` : '—'}</td>
      <td>${escHtml(run.jobAlias || run.jobId)}</td>
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

function showInlineError(message) {
  const el = document.getElementById('inline-error');
  el.textContent = message;
  el.hidden = false;
}

function clearInlineError() {
  const el = document.getElementById('inline-error');
  el.textContent = '';
  el.hidden = true;
}

async function copyToClipboard(value) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch {
    return false;
  }
}

function flashCopied(btn) {
  const original = btn.textContent;
  btn.textContent = '✓';
  btn.classList.add('copied');
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove('copied');
  }, 900);
}

async function apiAction(method, path) {
  const res = await fetch(path, { method });
  if (!res.ok) {
    let msg = `${method} ${path} failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error?.message) msg = body.error.message;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
}

async function handleJobAction(action, id) {
  try {
    if (action === 'disable') {
      if (!window.confirm('Disable this job? It will stop running on its schedule.')) return;
      await apiAction('POST', `/api/jobs/${encodeURIComponent(id)}/disable`);
    } else if (action === 'enable') {
      await apiAction('POST', `/api/jobs/${encodeURIComponent(id)}/enable`);
    } else if (action === 'delete') {
      if (!window.confirm('Delete this job permanently? This cannot be undone.')) return;
      await apiAction('DELETE', `/api/jobs/${encodeURIComponent(id)}`);
    }
    await loadDashboard();
  } catch (err) {
    showInlineError(err.message);
  }
}

async function openLogModal(runId) {
  const modal = document.getElementById('log-modal');
  const outputEl = document.getElementById('modal-output');
  const errorEl = document.getElementById('modal-error');
  const titleEl = document.getElementById('modal-title');
  titleEl.textContent = `Run logs · ${runId}`;
  outputEl.textContent = 'Loading…';
  errorEl.textContent = '';
  modal.hidden = false;
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/logs?source=all`);
    const logs = await res.json();
    if (!res.ok) throw new Error(logs?.error?.message || 'Failed to load logs');
    const output = logs
      .filter((l) => l.stream === 'stdout' || l.stream === 'crontick')
      .map((l) => l.data)
      .join('');
    const errorLines = logs
      .filter((l) => l.stream === 'stderr')
      .map((l) => l.data)
      .join('');
    const run = (lastData?.runs || []).find((r) => r.id === runId);
    const errorText = [errorLines, run?.error].filter(Boolean).join('\n');
    outputEl.textContent = output.length > 0 ? output : '(no output)';
    errorEl.textContent = errorText.length > 0 ? errorText : '(no errors)';
  } catch (err) {
    outputEl.textContent = '';
    errorEl.textContent = `Failed to load logs: ${err.message}`;
  }
}

function closeLogModal() {
  document.getElementById('log-modal').hidden = true;
}

document.getElementById('btn-refresh').addEventListener('click', () => void loadDashboard());
document.getElementById('runs-limit').addEventListener('change', () => void loadDashboard());
document.getElementById('filter-job').addEventListener('change', () => void loadDashboard());
document.getElementById('filter-status').addEventListener('change', () => {
  if (lastData) renderRuns(lastData.runs || []);
});
document.getElementById('sort-runs').addEventListener('change', () => {
  if (lastData) renderRuns(lastData.runs || []);
});

document.getElementById('jobs-tbody').addEventListener('click', (e) => {
  const copyBtn = e.target.closest('.copy-btn');
  if (copyBtn) {
    e.stopPropagation();
    void copyToClipboard(copyBtn.dataset.copy).then((ok) => { if (ok) flashCopied(copyBtn); });
    return;
  }
  const actionBtn = e.target.closest('.action-btn');
  if (actionBtn) {
    e.stopPropagation();
    void handleJobAction(actionBtn.dataset.action, actionBtn.dataset.id);
    return;
  }
  const row = e.target.closest('.job-row');
  if (row) {
    const select = document.getElementById('filter-job');
    select.value = row.dataset.id;
    void loadDashboard();
  }
});

document.getElementById('runs-tbody').addEventListener('click', (e) => {
  const copyBtn = e.target.closest('.copy-btn');
  if (copyBtn) {
    e.stopPropagation();
    void copyToClipboard(copyBtn.dataset.copy).then((ok) => { if (ok) flashCopied(copyBtn); });
    return;
  }
  const row = e.target.closest('.run-row');
  if (row) void openLogModal(row.dataset.id);
});

document.getElementById('modal-close').addEventListener('click', closeLogModal);
document.getElementById('log-modal').addEventListener('click', (e) => {
  if (e.target.id === 'log-modal') closeLogModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('log-modal').hidden) closeLogModal();
});

loadDashboard().catch((err) => {
  const badge = document.getElementById('health-badge');
  badge.textContent = `✗ ${err.message}`;
  badge.className = 'badge badge-error';
  showInlineError(err.message);
});
