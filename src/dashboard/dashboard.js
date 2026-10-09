'use strict';

const STATUSES = ['success', 'failed', 'running', 'canceled', 'timeout', 'queued', 'skipped', 'missed'];
const REFRESH_KEY = 'crontick.dashboard.autoRefreshSec';
const REFRESH_CHOICES = [0, 5, 10, 15, 30];
const SEARCH_DEBOUNCE_MS = 300;

let lastData = null;
let refreshTimer = null;
let toastTimer = null;
let lastFocus = null;
let drawerJobId = null;
let jobFilterSignature = '';

/** Client-side view state for the runs table (the filters are applied server-side). */
const state = {
  jobIds: new Set(),
  statuses: new Set(),
  runsQuery: '',
  jobsQuery: '',
  sort: { field: 'started', dir: 'desc' },
};

// ── Data loading ────────────────────────────────────────────────────────────

async function loadDashboard() {
  const runsLimit = document.getElementById('runs-limit')?.value || '100';
  const qs = new URLSearchParams({ runsLimit });
  if (state.jobIds.size) qs.set('jobId', [...state.jobIds].join(','));
  if (state.statuses.size) qs.set('status', [...state.statuses].join(','));
  if (state.runsQuery.trim()) qs.set('q', state.runsQuery.trim());
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
  if (drawerJobId && !document.getElementById('job-drawer').hidden) void renderDrawer(drawerJobId, { silent: true });
}

function renderDashboard(data) {
  renderHealth(data.health);
  renderSummary(data.stats);
  renderJobs(data.jobs || []);
  renderJobFilter(data.jobs || []);
  renderChips();
  renderRuns(data.runs || []);
}

// ── Formatting ──────────────────────────────────────────────────────────────

function formatSeconds(sec) {
  if (sec == null || Number.isNaN(Number(sec))) return '—';
  const n = Number(sec);
  return `${n >= 1 ? n.toFixed(1) : n.toFixed(2)} s`;
}

function formatMs(ms) {
  return ms == null ? '—' : formatSeconds(ms / 1000);
}

function formatTime(value) {
  if (value == null || value === '') return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function statusBadge(status) {
  if (!status) return '<span class="muted">—</span>';
  return `<span class="status-badge status-badge-${escHtml(status)}">${escHtml(capitalize(status))}</span>`;
}

function jobName(job) {
  return job.alias || job.id;
}

function jobLabelFor(jobId) {
  const job = (lastData?.jobs || []).find((j) => j.id === jobId);
  return job ? jobName(job) : (jobId || '');
}

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function copyIcon(value) {
  if (value == null || value === '') return '';
  return `<button class="icon-btn copy-btn" title="Copy" aria-label="Copy" data-copy="${escHtml(value)}">📋</button>`;
}

function emptyRow(cols, message) {
  return `<tr><td colspan="${cols}" class="muted">${escHtml(message)}</td></tr>`;
}

// ── Header / summary ────────────────────────────────────────────────────────

function renderHealth(health) {
  const badge = document.getElementById('health-badge');
  const versionEl = document.getElementById('version-info');
  badge.hidden = true;
  versionEl.textContent = `v${health.version} · pid ${health.pid}`;
}

function showHealthError(message) {
  const badge = document.getElementById('health-badge');
  badge.textContent = `✗ ${message}`;
  badge.className = 'badge badge-error';
  badge.hidden = false;
}

function renderSummary(stats) {
  document.getElementById('summary').innerHTML = `
    <div class="card"><strong>${escHtml(stats.enabledJobs)}/${escHtml(stats.totalJobs)}</strong><span>jobs enabled</span></div>
    <div class="card"><strong>${escHtml(stats.failed)}</strong><span>failed</span></div>
    <div class="card"><strong>${escHtml(formatSeconds(stats.avgDurationSec))}</strong><span>avg duration</span></div>
  `;
}

// ── Jobs table ──────────────────────────────────────────────────────────────

const RUN_NOW_TITLE = "Run once now (doesn't enable the job)";
const RUN_NOW_ICON = '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M11.5 1.5L4 11h5l-1 7.5L16 8.5h-5z" fill="currentColor"/></svg>';

function jobSearchText(job) {
  return JSON.stringify([job.alias, job.id, job.description, job.cwd, job.scheduleLabel, job.actionKind, job.lastStatus, job.job]).toLowerCase();
}

function visibleJobs(jobs) {
  const q = state.jobsQuery.trim().toLowerCase();
  return q ? jobs.filter((job) => jobSearchText(job).includes(q)) : jobs;
}

function renderJobs(allJobs) {
  const jobs = visibleJobs(allJobs);
  const tbody = document.getElementById('jobs-tbody');
  tbody.innerHTML = jobs.length === 0 ? emptyRow(8, allJobs.length ? 'No jobs match your search' : 'No jobs') : jobs.map((job) => {
    const toggle = job.enabled
      ? `<button class="icon-btn action-btn" data-action="disable" data-id="${escHtml(job.id)}" title="Disable job" aria-label="Disable job">⏹</button>`
      : `<button class="icon-btn action-btn" data-action="enable" data-id="${escHtml(job.id)}" title="Enable job" aria-label="Enable job">▶</button>`;
    return `
    <tr class="job-row" data-id="${escHtml(job.id)}" tabindex="0" aria-label="Show details for ${escHtml(jobName(job))}">
      <td>${escHtml(job.alias || '—')}</td>
      <td class="id-cell"><code title="${escHtml(job.id)}">${escHtml(job.id)}</code>${copyIcon(job.id)}</td>
      <td>${escHtml(job.description || '—')}</td>
      <td><code>${escHtml(job.scheduleLabel)}</code></td>
      <td>${escHtml(job.actionKind)}</td>
      <td class="status-${escHtml(job.lastStatus || 'queued')}">${escHtml(job.lastStatus || '—')}</td>
      <td>${escHtml(formatTime(job.nextRunAt))}</td>
      <td class="actions-cell">
        <button class="icon-btn action-btn run-now-btn" data-action="run-now" data-id="${escHtml(job.id)}" title="${escHtml(RUN_NOW_TITLE)}" aria-label="${escHtml(RUN_NOW_TITLE)}">${RUN_NOW_ICON}</button>
        ${toggle}
        <button class="icon-btn action-btn" data-action="delete" data-id="${escHtml(job.id)}" title="Delete job" aria-label="Delete job">🗑</button>
      </td>
    </tr>
  `;
  }).join('');
}

// ── Multi-select filters (runs) ─────────────────────────────────────────────

function multiEl(id) {
  return document.getElementById(id);
}

function buildMultiMenu(el, options, selected) {
  const menu = el.querySelector('.multi-menu');
  menu.innerHTML = options.map((o) => `
    <label class="multi-opt"><input type="checkbox" value="${escHtml(o.value)}"${selected.has(o.value) ? ' checked' : ''}> <span>${escHtml(o.label)}</span></label>
  `).join('') || '<div class="muted multi-empty">No options</div>';
}

function updateMultiButton(el, selected, allLabel, labelFor) {
  const btn = el.querySelector('.multi-btn');
  if (selected.size === 0) btn.textContent = allLabel;
  else if (selected.size === 1) btn.textContent = labelFor([...selected][0]);
  else btn.textContent = `${selected.size} selected`;
}

function renderStatusFilter() {
  const el = multiEl('filter-status');
  if (!el.querySelector('.multi-menu').children.length) {
    buildMultiMenu(el, STATUSES.map((s) => ({ value: s, label: s })), state.statuses);
  }
  updateMultiButton(el, state.statuses, 'All', (s) => s);
}

function renderJobFilter(jobs) {
  const el = multiEl('filter-job');
  const signature = jobs.map((j) => `${j.id}:${jobName(j)}`).join('|');
  // Rebuild only when the job list changed so an open menu keeps focus during refreshes.
  if (signature !== jobFilterSignature) {
    jobFilterSignature = signature;
    buildMultiMenu(el, jobs.map((j) => ({ value: j.id, label: jobName(j) })), state.jobIds);
  }
  updateMultiButton(el, state.jobIds, 'All jobs', jobLabelFor);
  renderStatusFilter();
}

function syncMultiChecks() {
  for (const [id, set] of [['filter-job', state.jobIds], ['filter-status', state.statuses]]) {
    multiEl(id).querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = set.has(cb.value); });
  }
}

function closeMultiMenus(except) {
  document.querySelectorAll('.multi').forEach((el) => {
    if (el === except) return;
    el.querySelector('.multi-menu').hidden = true;
    el.querySelector('.multi-btn').setAttribute('aria-expanded', 'false');
  });
}

function anyMultiOpen() {
  return [...document.querySelectorAll('.multi-menu')].some((m) => !m.hidden);
}

function renderChips() {
  const chips = [
    ...[...state.jobIds].map((v) => ({ kind: 'job', value: v, text: `alias:${jobLabelFor(v)}` })),
    ...[...state.statuses].map((v) => ({ kind: 'status', value: v, text: `status:${v}` })),
  ];
  document.getElementById('filter-chips').innerHTML = chips.map((c) => `
    <span class="chip chip-${c.kind}">
      <span class="chip-text">${escHtml(c.text)}</span>
      <button type="button" class="chip-x" data-kind="${c.kind}" data-value="${escHtml(c.value)}" aria-label="Remove filter ${escHtml(c.text)}" title="Remove filter">✕</button>
    </span>
  `).join('');
}

function removeFilter(kind, value) {
  (kind === 'job' ? state.jobIds : state.statuses).delete(value);
  syncMultiChecks();
  void reloadWithErrors();
}

function reloadWithErrors() {
  return loadDashboard().catch((err) => {
    showHealthError(err.message);
    showInlineError(err.message);
  });
}

// ── Runs table ──────────────────────────────────────────────────────────────

function sortedRuns(runs) {
  const { field, dir } = state.sort;
  const mul = dir === 'asc' ? 1 : -1;
  const key = (r) => {
    if (field === 'duration') return r.durationMs ?? -1;
    if (field === 'status') return r.status || '';
    if (field === 'job') return (r.jobAlias || r.jobId || '').toLowerCase();
    return r.startedAt;
  };
  return runs.slice().sort((a, b) => {
    const av = key(a);
    const bv = key(b);
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return cmp !== 0 ? cmp * mul : (b.startedAt - a.startedAt);
  });
}

function renderSortHeaders() {
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    const active = th.dataset.sort === state.sort.field;
    th.setAttribute('aria-sort', active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    th.querySelector('.sort-ind').textContent = active ? (state.sort.dir === 'asc' ? '▲' : '▼') : '⇅';
    th.classList.toggle('sorted', active);
  });
}

function renderRuns(runs) {
  const tbody = document.getElementById('runs-tbody');
  const rows = sortedRuns(runs);
  renderSortHeaders();
  tbody.innerHTML = rows.length === 0 ? emptyRow(6, 'No runs') : rows.map((run) => `
    <tr class="run-row" data-id="${escHtml(run.id)}" tabindex="0" aria-label="Open run ${escHtml(run.id)}">
      <td class="id-cell"><code title="${escHtml(run.id)}">${escHtml(run.id)}</code>${copyIcon(run.id)}</td>
      <td class="id-cell">${run.sessionId ? `<code title="${escHtml(run.sessionId)}">${escHtml(run.sessionId)}</code>${copyIcon(run.sessionId)}` : '—'}</td>
      <td>${escHtml(run.jobAlias || run.jobId)}</td>
      <td class="status-${escHtml(run.status)}">${escHtml(run.status)}</td>
      <td>${escHtml(formatTime(run.startedAt))}</td>
      <td>${escHtml(formatMs(run.durationMs))}</td>
    </tr>
  `).join('');
}

// ── Errors, toast, clipboard ────────────────────────────────────────────────

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

function showToast(message, isError) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('toast-error', Boolean(isError));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

async function copyToClipboard(value) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to the execCommand path
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

function handleCopyClick(e) {
  const copyBtn = e.target.closest('.copy-btn');
  if (!copyBtn) return false;
  e.stopPropagation();
  void copyToClipboard(copyBtn.dataset.copy).then((ok) => { if (ok) flashCopied(copyBtn); });
  return true;
}

// ── Job actions ─────────────────────────────────────────────────────────────

async function apiAction(method, path) {
  const res = await fetch(path, { method });
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(body?.error?.message || `${method} ${path} failed (${res.status})`);
  return body;
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
      if (drawerJobId === id) closeDrawer();
    } else if (action === 'run-now') {
      const body = await apiAction('POST', `/api/jobs/${encodeURIComponent(id)}/run-now`);
      showToast(`Started ${jobLabelFor(id)} once${body?.runId ? ` (run ${String(body.runId).slice(0, 8)})` : ''}`);
    }
    await loadDashboard();
  } catch (err) {
    showToast(err.message, true);
    showInlineError(err.message);
  }
}

// ── Job details drawer ──────────────────────────────────────────────────────

function kv(label, valueHtml) {
  return `<div class="kv"><dt>${escHtml(label)}</dt><dd>${valueHtml}</dd></div>`;
}

async function renderDrawer(jobId, opts = {}) {
  const wrapped = (lastData?.jobs || []).find((j) => j.id === jobId);
  const body = document.getElementById('drawer-body');
  if (!wrapped) {
    body.innerHTML = '<p class="muted">This job no longer exists.</p>';
    return;
  }
  const job = wrapped.job || {};
  const action = job.action || {};
  const [stats, runs] = await Promise.all([
    fetch(`/api/stats/jobs/${encodeURIComponent(jobId)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(`/api/runs?jobId=${encodeURIComponent(jobId)}&limit=10`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  if (drawerJobId !== jobId || document.getElementById('job-drawer').hidden) return;
  const finished = stats ? stats.succeeded + stats.failed + stats.canceled + stats.skipped : 0;
  const successRate = finished > 0 ? `${Math.round((stats.succeeded / finished) * 100)}%` : '—';
  const timeouts = [action.timeoutSec != null ? `${action.timeoutSec} s` : null].filter(Boolean).join(', ') || '—';
  const retry = job.retry ? `max ${job.retry.max}, backoff ${job.retry.backoffSec} s` : '—';
  const focusedAction = document.activeElement?.dataset?.drawerAction;
  document.getElementById('drawer-title').textContent = jobName(wrapped);
  body.innerHTML = `
    <div class="drawer-actions">
      <button type="button" class="btn" data-drawer-action="run-now" title="${escHtml(RUN_NOW_TITLE)}">${RUN_NOW_ICON} Run now</button>
      <button type="button" class="btn" data-drawer-action="${wrapped.enabled ? 'disable' : 'enable'}">${wrapped.enabled ? '⏹ Disable' : '▶ Enable'}</button>
      <button type="button" class="btn" data-drawer-action="filter-runs">Filter runs</button>
    </div>
    <h4>Config</h4>
    <dl class="kv-list">
      ${kv('Alias', escHtml(wrapped.alias || '—'))}
      ${kv('ID', `<code>${escHtml(wrapped.id)}</code>${copyIcon(wrapped.id)}`)}
      ${kv('Description', escHtml(wrapped.description || '—'))}
      ${kv('Enabled', wrapped.enabled ? 'Yes' : 'No (disabled)')}
      ${kv('Schedule', `<code>${escHtml(wrapped.scheduleLabel)}</code>`)}
      ${kv('Runner', escHtml([action.kind, action.engine].filter(Boolean).join(' / ') || '—'))}
      ${kv('Overlap', escHtml(job.overlap || '—'))}
      ${kv('Timeout', escHtml(timeouts))}
      ${kv('Retry', escHtml(retry))}
      ${kv('Working directory', (wrapped.cwd || action.cwd) ? `<code>${escHtml(wrapped.cwd || action.cwd)}</code>` : '—')}
      ${kv('Next run', escHtml(formatTime(wrapped.nextRunAt)))}
      ${kv('Last run', wrapped.lastRunAt ? `${escHtml(formatTime(wrapped.lastRunAt))} ${statusBadge(wrapped.lastStatus)}` : '—')}
    </dl>
    <h4>${escHtml(action.kind === 'prompt' || action.prompt ? 'Prompt' : 'Command')}</h4>
    <pre class="log-pane">${escHtml(action.prompt ?? action.command ?? JSON.stringify(action, null, 2))}</pre>
    <h4>Stats</h4>
    <div class="summary drawer-stats">
      <div class="card"><strong>${escHtml(successRate)}</strong><span>success rate</span></div>
      <div class="card"><strong>${escHtml(formatSeconds(stats?.avgDurationSec))}</strong><span>avg duration</span></div>
    </div>
    <h4>Recent runs</h4>
    ${runs.length === 0 ? '<p class="muted">No runs yet.</p>' : `
    <ul class="drawer-runs">${runs.map((r) => `
      <li><button type="button" class="drawer-run" data-run-id="${escHtml(r.id)}">
        <code>${escHtml(String(r.id).slice(0, 8))}</code>
        ${statusBadge(r.status)}
        <span class="muted">${escHtml(formatTime(r.startedAt))} · ${escHtml(formatMs(r.durationMs))}</span>
      </button></li>`).join('')}
    </ul>`}
  `;
  if (opts.silent && focusedAction) body.querySelector(`[data-drawer-action="${focusedAction}"]`)?.focus();
}

function openDrawer(jobId) {
  const drawer = document.getElementById('job-drawer');
  lastFocus = document.activeElement;
  drawerJobId = jobId;
  document.getElementById('drawer-body').innerHTML = '<p class="muted">Loading…</p>';
  drawer.hidden = false;
  drawer.querySelector('.drawer').focus();
  void renderDrawer(jobId).then(() => {
    const first = document.querySelector('#drawer-body [data-drawer-action]');
    if (first && drawerJobId === jobId && document.activeElement === drawer.querySelector('.drawer')) first.focus();
  });
}

function closeDrawer() {
  document.getElementById('job-drawer').hidden = true;
  drawerJobId = null;
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}

// ── Run detail ──────────────────────────────────────────────────────────────

let modalRunId = null;
let modalReturnFocus = null;

async function openRunModal(runId) {
  const modal = document.getElementById('log-modal');
  modalRunId = runId;
  modalReturnFocus = document.activeElement;
  document.getElementById('modal-title-text').textContent = `Run log – ${runId.slice(0, 8)} –`;
  document.getElementById('modal-title').title = runId;
  document.getElementById('modal-status').innerHTML = '';
  document.getElementById('modal-meta').textContent = '';
  document.getElementById('modal-error-section').hidden = true;
  document.getElementById('modal-output').textContent = 'Loading…';
  document.getElementById('modal-logfile').innerHTML = '';
  document.getElementById('modal-transcript').innerHTML = '';
  document.getElementById('modal-stderr-section').hidden = true;
  document.getElementById('modal-output-section').hidden = false;
  modal.hidden = false;
  modal.querySelector('.modal').focus();
  try {
    const [res, runRes] = await Promise.all([
      fetch(`/api/runs/${encodeURIComponent(runId)}/output`),
      fetch(`/api/runs/${encodeURIComponent(runId)}`),
    ]);
    const out = await res.json();
    let detail = null;
    try { detail = runRes.ok ? await runRes.json() : null; } catch { /* paths are optional */ }
    if (modalRunId !== runId) return;
    if (!res.ok) throw new Error(out?.error?.message || 'Failed to load run output');
    document.getElementById('modal-status').innerHTML = statusBadge(out.status);
    const run = (lastData?.runs || []).find((r) => r.id === runId);
    const meta = [
      run ? `Job: ${run.jobAlias || run.jobId}` : null,
      run ? `Started: ${formatTime(run.startedAt)}` : null,
      `Duration: ${formatMs(out.durationMs)}`,
      out.turns != null ? `Turns: ${out.turns}` : null,
      out.costUsd != null ? `Cost: $${Number(out.costUsd).toFixed(4)}` : null,
      out.sessionId ? `Runner Session ID: ${out.sessionId}` : null,
      out.truncated ? 'Output truncated' : null,
    ].filter(Boolean);
    document.getElementById('modal-meta').textContent = meta.join(' · ');
    document.getElementById('modal-error-section').hidden = !out.error;
    document.getElementById('modal-error').textContent = out.error || '';
    document.getElementById('modal-stderr-section').hidden = !out.stderr;
    document.getElementById('modal-stderr').textContent = out.stderr || '';
    const text = out.result || '';
    document.getElementById('modal-output-section').hidden = text.length === 0;
    document.getElementById('modal-output').textContent = text;
    renderPathRow('modal-logfile', detail ? detail.logFile : out.logFile, detail?.logFileExists, 'per-job log file disabled');
    renderPathRow('modal-transcript', detail?.transcriptPath, detail?.transcriptExists, 'no transcript recorded');
  } catch (err) {
    document.getElementById('modal-output-section').hidden = true;
    document.getElementById('modal-output').textContent = '';
    renderPathRow('modal-logfile', null, undefined, 'unavailable');
    renderPathRow('modal-transcript', null, undefined, 'unavailable');
    document.getElementById('modal-error-section').hidden = false;
    document.getElementById('modal-error').textContent = `Failed to load run output: ${err.message}`;
  }
}

/** Path row: the absolute path as plain selectable text (never a link) with a Copy button; file contents are never rendered. */
function renderPathRow(elId, path, exists, emptyText) {
  document.getElementById(elId).innerHTML = path
    ? `<code>${escHtml(path)}</code><button class="icon-btn copy-btn" title="Copy path" aria-label="Copy path" data-copy="${escHtml(path)}">Copy</button>${exists === false ? ' <span class="muted file-missing">file not found</span>' : ''}`
    : `<span class="muted">${escHtml(emptyText)}</span>`;
}

function closeRunModal() {
  document.getElementById('log-modal').hidden = true;
  modalRunId = null;
  if (modalReturnFocus && document.contains(modalReturnFocus)) modalReturnFocus.focus();
  modalReturnFocus = null;
}

// ── Search widgets ──────────────────────────────────────────────────────────

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function setupSearch(rootId, onQuery) {
  const root = document.getElementById(rootId);
  const input = root.querySelector('.search-input');
  const toggle = root.querySelector('.search-toggle');
  const fire = debounce(() => onQuery(input.value), SEARCH_DEBOUNCE_MS);
  const open = () => {
    root.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
    input.tabIndex = 0;
    input.focus();
  };
  const collapse = () => {
    root.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
    input.tabIndex = -1;
  };
  // Keep focus in the input on toggle press so blur-when-empty doesn't collapse-then-reopen.
  toggle.addEventListener('mousedown', (e) => e.preventDefault());
  toggle.addEventListener('click', () => {
    if (root.classList.contains('open') && !input.value) collapse();
    else open();
  });
  input.addEventListener('input', fire);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      const had = input.value !== '';
      input.value = '';
      collapse();
      toggle.focus();
      if (had) onQuery('');
    } else if (e.key === 'Enter') {
      onQuery(input.value);
    }
  });
  input.addEventListener('blur', () => { if (!input.value) collapse(); });
}

// ── Auto-refresh ────────────────────────────────────────────────────────────

function readRefreshSetting() {
  try {
    const v = Number(window.localStorage.getItem(REFRESH_KEY));
    return REFRESH_CHOICES.includes(v) ? v : 0;
  } catch {
    return 0;
  }
}

function applyAutoRefresh(sec, persist) {
  if (persist) {
    try { window.localStorage.setItem(REFRESH_KEY, String(sec)); } catch { /* storage unavailable */ }
  }
  document.querySelectorAll('#auto-refresh button').forEach((b) => {
    b.setAttribute('aria-checked', String(Number(b.dataset.sec) === sec));
  });
  clearInterval(refreshTimer);
  refreshTimer = null;
  if (sec > 0) {
    refreshTimer = setInterval(() => {
      if (!document.hidden) void loadDashboard().catch((err) => { showHealthError(err.message); showInlineError(err.message); });
    }, sec * 1000);
  }
}

// ── Focus trap ──────────────────────────────────────────────────────────────

function trapTab(e, container) {
  if (e.key !== 'Tab') return;
  const items = [...container.querySelectorAll('button, input, summary, a[href], [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === container)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// ── Event wiring ────────────────────────────────────────────────────────────

document.getElementById('btn-refresh').addEventListener('click', () => void reloadWithErrors());
document.getElementById('runs-limit').addEventListener('change', () => void reloadWithErrors());

document.getElementById('auto-refresh').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-sec]');
  if (btn) applyAutoRefresh(Number(btn.dataset.sec), true);
});

setupSearch('jobs-search', (q) => {
  state.jobsQuery = q;
  if (lastData) renderJobs(lastData.jobs || []);
});
setupSearch('runs-search', (q) => {
  state.runsQuery = q;
  void reloadWithErrors();
});

for (const [id, set] of [['filter-job', state.jobIds], ['filter-status', state.statuses]]) {
  const el = multiEl(id);
  const btn = el.querySelector('.multi-btn');
  const menu = el.querySelector('.multi-menu');
  btn.addEventListener('click', () => {
    const willOpen = menu.hidden;
    closeMultiMenus(el);
    menu.hidden = !willOpen;
    btn.setAttribute('aria-expanded', String(willOpen));
  });
  menu.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    if (cb.checked) set.add(cb.value);
    else set.delete(cb.value);
    void reloadWithErrors(); // the menu stays open while toggling
  });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.multi')) closeMultiMenus();
});

document.getElementById('filter-chips').addEventListener('click', (e) => {
  const x = e.target.closest('.chip-x');
  if (x) removeFilter(x.dataset.kind, x.dataset.value);
});

document.querySelector('#runs-tbody').closest('table').querySelector('thead').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (!th || !e.target.closest('.sort-btn')) return;
  const field = th.dataset.sort;
  if (state.sort.field === field) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  else state.sort = { field, dir: field === 'started' ? 'desc' : 'asc' };
  if (lastData) renderRuns(lastData.runs || []);
});

document.getElementById('jobs-tbody').addEventListener('click', (e) => {
  if (handleCopyClick(e)) return;
  const actionBtn = e.target.closest('.action-btn');
  if (actionBtn) {
    e.stopPropagation();
    void handleJobAction(actionBtn.dataset.action, actionBtn.dataset.id);
    return;
  }
  const row = e.target.closest('.job-row');
  if (row) openDrawer(row.dataset.id);
});
document.getElementById('jobs-tbody').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('job-row')) {
    e.preventDefault();
    openDrawer(e.target.dataset.id);
  }
});

document.getElementById('runs-tbody').addEventListener('click', (e) => {
  if (handleCopyClick(e)) return;
  const row = e.target.closest('.run-row');
  if (row) void openRunModal(row.dataset.id);
});
document.getElementById('runs-tbody').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('run-row')) {
    e.preventDefault();
    void openRunModal(e.target.dataset.id);
  }
});

document.getElementById('drawer-body').addEventListener('click', (e) => {
  if (handleCopyClick(e)) return;
  const runBtn = e.target.closest('.drawer-run');
  if (runBtn) {
    void openRunModal(runBtn.dataset.runId);
    return;
  }
  const btn = e.target.closest('[data-drawer-action]');
  if (!btn || !drawerJobId) return;
  const action = btn.dataset.drawerAction;
  if (action === 'filter-runs') {
    state.jobIds.clear();
    state.jobIds.add(drawerJobId);
    syncMultiChecks();
    closeDrawer();
    void reloadWithErrors();
    return;
  }
  void handleJobAction(action, drawerJobId);
});

document.getElementById('drawer-close').addEventListener('click', closeDrawer);
document.getElementById('job-drawer').addEventListener('click', (e) => {
  if (e.target.id === 'job-drawer') closeDrawer();
});
document.getElementById('job-drawer').addEventListener('keydown', (e) => trapTab(e, document.querySelector('#job-drawer .drawer')));

document.getElementById('modal-close').addEventListener('click', closeRunModal);
document.getElementById('log-modal').addEventListener('click', (e) => {
  if (e.target.id === 'log-modal') closeRunModal();
});
document.getElementById('log-modal').addEventListener('keydown', (e) => trapTab(e, document.querySelector('#log-modal .modal')));
document.getElementById('modal-logfile').addEventListener('click', handleCopyClick);
document.getElementById('modal-transcript').addEventListener('click', handleCopyClick);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!document.getElementById('log-modal').hidden) closeRunModal();
  else if (!document.getElementById('job-drawer').hidden) closeDrawer();
  else if (anyMultiOpen()) closeMultiMenus();
});

applyAutoRefresh(readRefreshSetting(), false);
loadDashboard().catch((err) => {
  showHealthError(err.message);
  showInlineError(err.message);
});


// ── Theme toggle (system / light / dark) ─────────────────────────────────────
// The saved choice is applied early by an inline script in index.html; this wires the buttons.
const THEME_KEY = 'crontick.theme';
function applyTheme(choice) {
  if (choice === 'light' || choice === 'dark') document.documentElement.setAttribute('data-theme', choice);
  else document.documentElement.removeAttribute('data-theme');
  document.querySelectorAll('#theme-toggle button').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.themeChoice === (choice === 'light' || choice === 'dark' ? choice : 'system')));
  });
}
(function initTheme() {
  let saved = 'system';
  try { const v = window.localStorage.getItem(THEME_KEY); if (v === 'light' || v === 'dark') saved = v; } catch { /* storage unavailable */ }
  applyTheme(saved);
  document.getElementById('theme-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-theme-choice]');
    if (!btn) return;
    const choice = btn.dataset.themeChoice;
    try {
      if (choice === 'system') window.localStorage.removeItem(THEME_KEY);
      else window.localStorage.setItem(THEME_KEY, choice);
    } catch { /* storage unavailable */ }
    applyTheme(choice);
  });
})();
