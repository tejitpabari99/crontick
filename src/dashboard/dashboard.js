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
  void refreshPaused();
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
      <td><code>${escHtml(job.scheduleLabel)}</code>${job.job?.catchUp ? ' <span class="badge badge-catchup" title="Runs the most recent missed fire once on daemon start">catch-up</span>' : ''}</td>
      <td>${escHtml(job.actionKind)}</td>
      <td class="status-${escHtml(job.lastStatus || 'queued')}">${escHtml(job.lastStatus || '—')}</td>
      <td>${escHtml(formatTime(job.nextRunAt))}</td>
      <td class="actions-cell">
        <button class="icon-btn action-btn" data-action="edit" data-id="${escHtml(job.id)}" title="Edit job" aria-label="Edit job">✎</button>
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
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(body?.error?.message || `${method} ${path} failed (${res.status})`);
  return body;
}

async function handleJobAction(action, id) {
  if (action === 'edit') {
    void openEditor(id);
    return;
  }
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
  const isWebhook = job.schedule?.kind === 'webhook';
  const [stats, runs, relays] = await Promise.all([
    fetch(`/api/stats/jobs/${encodeURIComponent(jobId)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(`/api/runs?jobId=${encodeURIComponent(jobId)}&limit=10`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    isWebhook && job.schedule.relay
      ? fetch('/api/relays').then((r) => (r.ok ? r.json() : [])).catch(() => [])
      : Promise.resolve([]),
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
      ${isWebhook ? '<button type="button" class="btn" data-drawer-action="trigger-toggle">⚡ Trigger now</button>' : ''}
    </div>
    ${isWebhook ? `<div class="drawer-trigger" hidden>
      <label for="drawer-trigger-payload">Payload (JSON or text, optional)</label>
      <textarea id="drawer-trigger-payload" class="drawer-trigger-payload" rows="4" placeholder='{"hello":"world"}'></textarea>
      <button type="button" class="btn btn-primary" data-drawer-action="trigger">Fire</button>
    </div>` : ''}
    <h4>Config</h4>
    <dl class="kv-list">
      ${kv('Alias', escHtml(wrapped.alias || '—'))}
      ${kv('ID', `<code>${escHtml(wrapped.id)}</code>${copyIcon(wrapped.id)}`)}
      ${kv('Description', escHtml(wrapped.description || '—'))}
      ${kv('Enabled', wrapped.enabled ? 'Yes' : 'No (disabled)')}
      ${kv('Schedule', `<code>${escHtml(wrapped.scheduleLabel)}</code>`)}
      ${kv('Catch-up', job.catchUp ? 'On' : 'Off')}
      ${kv('Runner', escHtml([action.kind, action.engine].filter(Boolean).join(' / ') || '—'))}
      ${kv('Overlap', escHtml(job.overlap || '—'))}
      ${kv('Timeout', escHtml(timeouts))}
      ${kv('Retry', escHtml(retry))}
      ${kv('Working directory', (wrapped.cwd || action.cwd) ? `<code>${escHtml(wrapped.cwd || action.cwd)}</code>` : '—')}
      ${isWebhook ? kv('Relay', relayRowHtml(job.schedule, relays)) : ''}
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

/** Webhook relay row: read-only (redacted) URL, status dot from GET /api/relays, and a Copy that fetches the full URL. */
function relayRowHtml(schedule, relays) {
  if (!schedule.relay) return '<span class="muted">local trigger only</span>';
  const status = (relays || []).find((r) => r.urlRedacted === schedule.relay);
  const state = status?.state || 'unknown';
  const title = status ? `${state}${status.lastError ? `: ${status.lastError}` : ''}${status.lastEventAt ? ` · last event ${formatTime(status.lastEventAt)}` : ''}` : 'status unknown';
  return `<span class="relay-dot relay-${escHtml(state)}" title="${escHtml(title)}" aria-label="${escHtml(title)}"></span><code>${escHtml(schedule.relay)}</code>`
    + ` <button type="button" class="icon-btn" data-drawer-action="copy-relay" title="Copy full relay URL" aria-label="Copy full relay URL">📋</button>`;
}

/** Copy needs the unredacted URL, which only GET /api/jobs/:id returns. */
async function copyRelayUrl(jobId) {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { headers: { 'Content-Type': 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.schedule?.relay) throw new Error(body?.error?.message || 'Relay URL unavailable');
  if (await copyToClipboard(body.schedule.relay)) showToast('Relay URL copied');
  else throw new Error('Copy failed');
}

/** Trigger now: POST /api/jobs/:id/trigger with the optional payload; JSON when it parses, else raw text. */
async function triggerJobNow(jobId) {
  const text = document.getElementById('drawer-trigger-payload')?.value ?? '';
  const body = {};
  if (text.trim()) {
    try { body.payload = JSON.parse(text); } catch { body.payload = text; }
  }
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/trigger`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `Trigger failed (${res.status})`);
  showToast(`Triggered run ${String(data.runId).slice(0, 8)}`);
  await loadDashboard().catch(() => {});
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
  document.getElementById('modal-trigger-section').hidden = true;
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
    document.getElementById('modal-trigger-section').hidden = !detail?.trigger;
    document.getElementById('modal-trigger').innerHTML = detail?.trigger ? renderTriggerHtml(detail.trigger) : '';
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
  const items = [...container.querySelectorAll('button, input, select, textarea, summary, a[href], [tabindex]:not([tabindex="-1"])')]
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

// ── Settings modal (config API) ─────────────────────────────────────────────

// <settings-pure>
const SETTINGS_SCALARS = [
  'defaultEngine', 'maxConsecutiveFailures',
  'defaults.overlap', 'defaults.timeoutSec', 'defaults.retry.max', 'defaults.retry.backoffSec',
  'retention.maxRunsPerJob', 'retention.maxOutputBytesPerRun', 'retention.maxLogFiles',
  'logging.fileEnabled', 'logging.dir',
];

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Text of a numeric input -> number; blank -> undefined (optional) or '' (required, so the server reports it); junk stays text. */
function parseNumberField(text, optional) {
  const t = String(text ?? '').trim();
  if (t === '') return optional ? undefined : '';
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

/**
 * PATCH op batch of ONLY the changed leaves (never daemon.*; redacted values echoed back unchanged
 * are not leaves that changed). Order: engine adds, scalars, engine leaf edits, engine removals.
 */
function buildSettingsOps(base, draft) {
  const adds = [];
  const edits = [];
  const removals = [];
  const scalars = [];
  const baseEngines = (base && base.engines) || {};
  const draftEngines = (draft && draft.engines) || {};
  for (const name of Object.keys(draftEngines)) {
    const e = draftEngines[name];
    if (!(name in baseEngines)) {
      adds.push({ op: 'set', key: `engines.${name}`, value: { command: e.command, args: e.args || [], env: e.env || {}, type: e.type } });
      continue;
    }
    const b = baseEngines[name];
    if (e.command !== b.command) edits.push({ op: 'set', key: `engines.${name}.command`, value: e.command });
    if (e.type !== b.type) edits.push({ op: 'set', key: `engines.${name}.type`, value: e.type });
    if (!jsonEqual(e.args || [], b.args || [])) edits.push({ op: 'set', key: `engines.${name}.args`, value: e.args || [] });
    const be = b.env || {};
    const de = e.env || {};
    for (const k of Object.keys(de)) {
      if (!(k in be) || de[k] !== be[k]) edits.push({ op: 'set', key: `engines.${name}.env.${k}`, value: de[k] });
    }
    for (const k of Object.keys(be)) {
      if (!(k in de)) edits.push({ op: 'unset', key: `engines.${name}.env.${k}` });
    }
  }
  for (const name of Object.keys(baseEngines)) {
    if (!(name in draftEngines)) removals.push({ op: 'unset', key: `engines.${name}` });
  }
  for (const key of SETTINGS_SCALARS) {
    const a = getPath(base, key);
    const b = getPath(draft, key);
    if (jsonEqual(a, b)) continue;
    scalars.push(b === undefined ? { op: 'unset', key } : { op: 'set', key, value: b });
  }
  return [...adds, ...scalars, ...edits, ...removals];
}

/** Inputs an error key maps to: exact matches, else fields on the same path (error deeper or shallower than the field). */
function matchFieldKeys(errorKey, fields) {
  if (!errorKey) return [];
  const exact = fields.filter((f) => f === errorKey);
  if (exact.length) return exact;
  return fields.filter((f) => errorKey.startsWith(`${f}.`) || f.startsWith(`${errorKey}.`));
}
// </settings-pure>

const DISCARD_MESSAGE = 'Discard unsaved changes? Changes will be lost.';
const ENGINE_NAME_RE = /^[A-Za-z0-9_-]+$/;
const OVERLAP_CHOICES = ['skip', 'queue', 'cancel-previous'];
let settingsBase = null;
let settingsEditing = false;
let settingsBusy = false;
let settingsReturnFocus = null;
let pausedState = false;

const settingsModal = document.getElementById('settings-modal');
const settingsForm = document.getElementById('settings-form');
const settingsSave = document.getElementById('settings-save');
const settingsEditBtn = document.getElementById('settings-edit');
const settingsBanner = document.getElementById('settings-banner');
const settingsInflight = document.getElementById('settings-inflight');

function cloneJson(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) {
    if (o[p] == null || typeof o[p] !== 'object') o[p] = {};
    o = o[p];
  }
  o[parts[parts.length - 1]] = value;
}

function inputHtml(key, kind, value, choices) {
  const k = escHtml(key);
  if (kind === 'bool') return `<input type="checkbox" data-key="${k}" data-field="${k}" data-kind="bool"${value ? ' checked' : ''}>`;
  if (kind === 'select') {
    return `<select data-key="${k}" data-field="${k}" data-kind="select">${choices.map((c) => `<option value="${escHtml(c)}"${c === value ? ' selected' : ''}>${escHtml(c)}</option>`).join('')}</select>`;
  }
  const num = kind === 'number' || kind === 'optnumber';
  return `<input type="${num ? 'number' : 'text'}"${num ? ' step="any"' : ''} data-key="${k}" data-field="${k}" data-kind="${kind}" value="${escHtml(value ?? '')}">`;
}

function gridRow(label, key, kind, cfg, choices, hint) {
  return `<label>${escHtml(label)}</label><div>${inputHtml(key, kind, getPath(cfg, key), choices)}${hint ? `<div class="settings-hint">${escHtml(hint)}</div>` : ''}</div>`;
}

function engineCardHtml(name, e, isDefault) {
  const n = escHtml(name);
  const args = (e.args || []).map((a, i) => `<div class="kv-row args-row"><input type="text" data-field="engines.${n}.args" aria-label="Argument ${i + 1}" value="${escHtml(a)}"><button type="button" class="icon-btn" data-act="remove-arg" aria-label="Remove argument">✕</button></div>`).join('');
  const env = Object.entries(e.env || {}).map(([k, v]) => `<div class="kv-row env-row"><input type="text" class="env-key" data-field="engines.${n}.env.${escHtml(k)}" aria-label="Variable name" value="${escHtml(k)}"><input type="text" class="env-val" data-field="engines.${n}.env.${escHtml(k)}" aria-label="Value of ${escHtml(k)}" value="${escHtml(v)}"><button type="button" class="icon-btn" data-act="remove-env" aria-label="Remove variable">✕</button></div>`).join('');
  return `
    <div class="engine-card" data-engine="${n}">
      <div class="engine-card-head">
        <span><strong>${n}</strong>${isDefault ? ' <span class="badge badge-ok engine-tag">default engine</span>' : ''}</span>
        <button type="button" class="btn" data-act="remove-engine" title="Remove engine">Remove</button>
      </div>
      <div class="settings-grid">
        <label>Command</label><input type="text" class="eng-command" data-field="engines.${n}.command" value="${escHtml(e.command)}">
        <label>Type</label><select class="eng-type" data-field="engines.${n}.type">${['claude', 'raw'].map((t) => `<option value="${t}"${t === e.type ? ' selected' : ''}>${t}</option>`).join('')}</select>
        <label>Args</label><div class="kv-rows">${args}<div><button type="button" class="btn" data-act="add-arg">+ Add arg</button></div></div>
        <label>Env</label><div class="kv-rows">${env}<div><button type="button" class="btn" data-act="add-env">+ Add variable</button></div></div>
      </div>
    </div>`;
}

function renderSettingsForm(cfg) {
  const engineNames = Object.keys(cfg.engines || {});
  const port = cfg.daemon && cfg.daemon.port != null ? String(cfg.daemon.port) : 'default';
  settingsForm.innerHTML = `
    <section class="settings-section"><h4>General</h4><div class="settings-grid">
      ${gridRow('Default engine', 'defaultEngine', 'select', cfg, engineNames)}
      ${gridRow('Max consecutive failures', 'maxConsecutiveFailures', 'number', cfg)}
    </div></section>
    <section class="settings-section"><h4>Job defaults</h4><div class="settings-grid">
      ${gridRow('Overlap', 'defaults.overlap', 'select', cfg, OVERLAP_CHOICES)}
      ${gridRow('Timeout (sec)', 'defaults.timeoutSec', 'optnumber', cfg, null, 'Leave blank for no default timeout.')}
      ${gridRow('Retry max', 'defaults.retry.max', 'number', cfg)}
      ${gridRow('Retry backoff (sec)', 'defaults.retry.backoffSec', 'number', cfg)}
    </div></section>
    <section class="settings-section"><h4>Retention</h4><div class="settings-grid">
      ${gridRow('Max runs per job', 'retention.maxRunsPerJob', 'number', cfg)}
      ${gridRow('Max output bytes per run', 'retention.maxOutputBytesPerRun', 'number', cfg)}
      ${gridRow('Max daemon log files', 'retention.maxLogFiles', 'number', cfg)}
    </div></section>
    <section class="settings-section"><h4>Logging</h4><div class="settings-grid">
      ${gridRow('Per-job log files', 'logging.fileEnabled', 'bool', cfg)}
      ${gridRow('Log directory', 'logging.dir', 'optstring', cfg, null, 'Leave blank for the default logs folder.')}
    </div></section>
    <section class="settings-section"><h4>Engines</h4>
      <div id="settings-engines">${engineNames.map((n) => engineCardHtml(n, cfg.engines[n], n === cfg.defaultEngine)).join('')}</div>
      <div class="settings-add-engine"><input type="text" id="new-engine-name" aria-label="New engine name" placeholder="new engine name"><button type="button" class="btn" data-act="add-engine">+ Add engine</button></div>
    </section>
    <section class="settings-section settings-port"><h4>Daemon</h4><div class="settings-grid">
      <label>Port</label><div><code id="settings-port">${escHtml(port)}</code>
      <div class="settings-hint">Read-only here: stop the daemon, then run <code>crontick config set daemon.port &lt;n&gt;</code> or hand-edit config.json.</div></div>
    </div></section>`;
  applyEditable();
}

/** Draft config assembled from the form controls (same shape as the effective config). */
function collectDraft() {
  const draft = cloneJson(settingsBase.config);
  settingsForm.querySelectorAll('[data-key]').forEach((el) => {
    const key = el.dataset.key;
    const kind = el.dataset.kind;
    let value;
    if (kind === 'bool') value = el.checked;
    else if (kind === 'number') value = parseNumberField(el.value, false);
    else if (kind === 'optnumber') value = parseNumberField(el.value, true);
    else if (kind === 'optstring') value = el.value.trim() === '' ? undefined : el.value;
    else value = el.value;
    setPath(draft, key, value);
  });
  const engines = {};
  settingsForm.querySelectorAll('.engine-card').forEach((card) => {
    const env = {};
    card.querySelectorAll('.env-row').forEach((row) => {
      const k = row.querySelector('.env-key').value.trim();
      if (k) env[k] = row.querySelector('.env-val').value;
    });
    engines[card.dataset.engine] = {
      command: card.querySelector('.eng-command').value,
      type: card.querySelector('.eng-type').value,
      args: [...card.querySelectorAll('.args-row input')].map((i) => i.value).filter((v) => v !== ''),
      env,
    };
  });
  draft.engines = engines;
  return draft;
}

function settingsDirty() {
  return settingsEditing && buildSettingsOps(settingsBase.config, collectDraft()).length > 0;
}

/** Inputs follow edit mode; the default engine (and the last engine) can't be removed. */
function applyEditable() {
  settingsForm.querySelectorAll('input, select, button').forEach((el) => { el.disabled = !settingsEditing; });
  const cards = settingsForm.querySelectorAll('.engine-card');
  const defaultEngine = settingsForm.querySelector('[data-key="defaultEngine"]')?.value;
  cards.forEach((card) => {
    const rm = card.querySelector('[data-act="remove-engine"]');
    const isDefault = card.dataset.engine === defaultEngine;
    const tag = card.querySelector('.engine-tag');
    if (tag) tag.hidden = !isDefault;
    if (isDefault || cards.length <= 1) {
      rm.disabled = true;
      rm.title = isDefault ? 'The default engine cannot be removed: pick another default first' : 'At least one engine is required';
    } else {
      rm.title = 'Remove engine';
    }
  });
  settingsSave.disabled = !settingsEditing || settingsBusy;
  settingsEditBtn.hidden = settingsEditing;
}

function clearSettingsFeedback() {
  settingsBanner.hidden = true;
  settingsBanner.textContent = '';
  settingsInflight.hidden = true;
  settingsInflight.innerHTML = '';
  settingsForm.querySelectorAll('.field-error').forEach((el) => el.classList.remove('field-error'));
}

function showSettingsError(message, key, extraHtml) {
  settingsBanner.innerHTML = `<span>${escHtml(message)}</span>${extraHtml || ''}`;
  settingsBanner.hidden = false;
  settingsForm.querySelectorAll('.field-error').forEach((el) => el.classList.remove('field-error'));
  if (key) {
    const fields = [...settingsForm.querySelectorAll('[data-field]')];
    const hits = matchFieldKeys(key, fields.map((f) => f.dataset.field));
    fields.filter((f) => hits.includes(f.dataset.field)).forEach((f) => f.classList.add('field-error'));
    settingsForm.querySelector('.field-error')?.scrollIntoView?.({ block: 'center' });
  }
}

async function loadSettings() {
  const res = await fetch('/api/config');
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message || `GET /api/config failed (${res.status})`);
  settingsBase = { path: body.path, revision: body.revision, config: body.config, notice: body.notice };
  document.getElementById('settings-path').textContent = body.path || '';
  renderSettingsForm(settingsBase.config);
}

async function openSettings() {
  settingsReturnFocus = document.activeElement;
  settingsEditing = false;
  settingsBusy = false;
  clearSettingsFeedback();
  settingsForm.innerHTML = '<p class="muted">Loading…</p>';
  settingsModal.hidden = false;
  settingsModal.querySelector('.modal').focus();
  applyEditable();
  try {
    await loadSettings();
  } catch (err) {
    showSettingsError(err.message);
  }
}

function closeSettings() {
  settingsModal.hidden = true;
  settingsEditing = false;
  if (settingsReturnFocus && document.contains(settingsReturnFocus)) settingsReturnFocus.focus();
  settingsReturnFocus = null;
}

function exitEdit() {
  settingsEditing = false;
  clearSettingsFeedback();
  if (settingsBase) renderSettingsForm(settingsBase.config);
  else applyEditable();
}

/** Cancel / ✕ / backdrop / Esc: dirty edit confirms; clean edit leaves edit mode; read-only closes. */
function requestLeaveSettings() {
  if (settingsBusy) return;
  if (settingsEditing) {
    if (settingsDirty() && !window.confirm(DISCARD_MESSAGE)) return;
    exitEdit();
  } else {
    closeSettings();
  }
}

function showInflightChoice(runs) {
  const list = runs.map((r) => `<code>${escHtml(String(r.runId || r.id || '').slice(0, 8))}</code>`).join(', ');
  settingsInflight.innerHTML = `
    <div>${escHtml(String(runs.length))} run(s) in flight${list ? `: ${list}` : ''}. How should this save proceed?</div>
    <div class="row">
      <button type="button" class="btn" data-inflight="stop">Stop running jobs, then save</button>
      <button type="button" class="btn" data-inflight="wait">Pause and wait for runs, then save</button>
      <button type="button" class="btn" data-inflight="cancel">Cancel save</button>
    </div>`;
  settingsInflight.hidden = false;
}

async function saveSettings(choice) {
  if (!settingsEditing || settingsBusy) return;
  const ops = buildSettingsOps(settingsBase.config, collectDraft());
  clearSettingsFeedback();
  if (ops.length === 0) {
    showToast('No changes to save');
    exitEdit();
    return;
  }
  settingsBusy = true;
  applyEditable();
  try {
    const res = await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops, ifRevision: settingsBase.revision, ...(choice ? { inFlight: choice } : {}) }),
    });
    const body = await res.json().catch(() => null);
    if (res.ok) {
      settingsBusy = false;
      settingsEditing = false;
      await loadSettings();
      showToast(`Settings saved. ${body?.notice || settingsBase.notice || ''}`.trim());
      void loadDashboard().catch(() => {});
      void refreshPaused();
      return;
    }
    const err = body?.error || {};
    if (res.status === 409 && err.code === 'RUNS_IN_FLIGHT') {
      showInflightChoice(err.details?.runs || []);
    } else if (res.status === 409 && err.code === 'CONFIG_CONFLICT') {
      showSettingsError('Config changed on disk', null, '<button type="button" class="btn" data-act="reload-form">Reload form</button>');
    } else {
      showSettingsError(err.message || `Save failed (${res.status})`, err.details?.key);
    }
  } catch (err) {
    showSettingsError(err.message || 'Save failed');
  } finally {
    settingsBusy = false;
    applyEditable();
  }
}

function addEngineCard() {
  const input = document.getElementById('new-engine-name');
  const name = input.value.trim();
  if (!ENGINE_NAME_RE.test(name)) {
    showSettingsError('Engine names can contain letters, numbers, underscore and dash.');
    input.classList.add('field-error');
    return;
  }
  const draft = collectDraft();
  if (draft.engines[name]) {
    showSettingsError(`Engine "${name}" already exists.`);
    input.classList.add('field-error');
    return;
  }
  draft.engines[name] = { command: '', type: 'raw', args: [], env: {} };
  clearSettingsFeedback();
  renderSettingsForm(draft);
  settingsForm.querySelector(`.engine-card[data-engine="${name}"] .eng-command`)?.focus();
}

settingsForm.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || !settingsEditing) return;
  const act = btn.dataset.act;
  const card = btn.closest('.engine-card');
  if (act === 'add-engine') return addEngineCard();
  const draft = collectDraft();
  if (act === 'remove-engine') {
    delete draft.engines[card.dataset.engine];
  } else if (act === 'add-arg') {
    draft.engines[card.dataset.engine].args.push('');
  } else if (act === 'remove-arg') {
    const rows = [...card.querySelectorAll('.args-row')];
    const idx = rows.indexOf(btn.closest('.args-row'));
    const args = [...card.querySelectorAll('.args-row input')].map((i) => i.value);
    args.splice(idx, 1);
    draft.engines[card.dataset.engine].args = args;
  } else if (act === 'add-env' || act === 'remove-env') {
    const eng = draft.engines[card.dataset.engine];
    if (act === 'add-env') {
      let n = 1;
      while (`NEW_VAR_${n}` in eng.env) n += 1;
      eng.env[`NEW_VAR_${n}`] = '';
    } else {
      delete eng.env[btn.closest('.env-row').querySelector('.env-key').value.trim()];
    }
  } else {
    return;
  }
  renderSettingsForm(draft);
});
settingsForm.addEventListener('input', (e) => e.target.classList?.remove('field-error'));
settingsForm.addEventListener('change', (e) => {
  if (e.target.dataset?.key === 'defaultEngine') applyEditable();
});

settingsEditBtn.addEventListener('click', () => {
  if (!settingsBase) return;
  settingsEditing = true;
  clearSettingsFeedback();
  applyEditable();
  settingsForm.querySelector('input, select')?.focus();
});
settingsSave.addEventListener('click', () => void saveSettings());
document.getElementById('settings-cancel').addEventListener('click', requestLeaveSettings);
document.getElementById('settings-close').addEventListener('click', requestLeaveSettings);
document.getElementById('btn-settings').addEventListener('click', () => void openSettings());
settingsModal.addEventListener('click', (e) => {
  if (e.target.id === 'settings-modal') requestLeaveSettings();
});
settingsModal.addEventListener('keydown', (e) => trapTab(e, settingsModal.querySelector('.modal')));
settingsBanner.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-act="reload-form"]')) return;
  try {
    clearSettingsFeedback();
    await loadSettings(); // discards the edits; stays in edit mode on the fresh values
  } catch (err) {
    showSettingsError(err.message);
  }
});
settingsInflight.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-inflight]');
  if (!btn) return;
  const choice = btn.dataset.inflight;
  if (choice === 'cancel') {
    settingsInflight.hidden = true;
    return;
  }
  settingsInflight.innerHTML = `<div>${choice === 'wait' ? 'Paused; waiting for in-flight runs to finish, then saving…' : 'Stopping in-flight runs and saving…'}</div>`;
  void saveSettings(choice);
});

// ── Job editor (create / edit modal) ────────────────────────────────────────

// <editor-pure>
/** CLI flag (commonJobOptions) -> form field id (data-editor-field); null = intentionally not in the form. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- read by tests/unit/dashboard-job-editor.test.ts
const EDITOR_CLI_PARITY = {
  '--alias': 'alias',
  '--prompt': 'prompt',
  '--prompt-file': null, // file picker N/A: textarea only
  '--cron': 'schedule', // schedule controls live behind editorScheduleHook (Task 6)
  '--every': 'schedule',
  '--at': 'schedule',
  '--after': 'schedule', // `after` SCHEDULE_KINDS entry (upstream select)
  '--after-status': 'schedule',
  '--webhook': 'schedule', // `webhook` SCHEDULE_KINDS entry (relay URL + secret fields)
  '--relay': 'schedule',
  '--webhook-secret': 'schedule',
  '--dir': 'cwd',
  '--trust-folder': 'trustFolder', // revealed after TRUST_REQUIRED (Task 7)
  '--runner': 'engine',
  '--session-id': 'sessionId',
  '--reuse-session': 'reuseSession',
  '--file': null, // JSON import N/A
  '--timeout': 'timeoutSec',
  '--overlap': 'overlap',
  '--retry': 'retryMax',
  '--desc': 'description',
  '--catch-up': 'catchUp', // checkbox inside the schedule section, shown only for supportsCatchUp kinds
  '--no-catch-up': 'catchUp',
};

/** '' -> undefined (blank), numeric text -> number, anything else -> 'invalid'. */
function parseOptionalNumber(text) {
  const t = String(text ?? '').trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : 'invalid';
}

function cleanArgs(args) {
  return (args || []).filter((a) => String(a).trim() !== '');
}

/** Empty create form; engine/overlap/retry come from GET /api/jobs/editor-meta, directory has no default. */
function blankEditorValues(meta) {
  const d = meta?.defaults || {};
  return {
    alias: '', prompt: '', cwd: '', engine: meta?.defaultEngine || '', args: [], sessionId: '', 'reuseSession': false, catchUp: false,
    timeoutSec: d.timeoutSec != null ? String(d.timeoutSec) : '', overlap: d.overlap || 'skip',
    retryMax: d.retry?.max != null ? String(d.retry.max) : '', backoffSec: '', description: '',
  };
}

/** Loaded Job -> flat form values (env/envFile are intentionally not represented). */
function jobToEditorValues(job) {
  const a = job?.action || {};
  const str = (v) => (v == null ? '' : String(v));
  return {
    alias: str(job?.alias), prompt: str(a.prompt), cwd: str(a.cwd), engine: str(a.engine), args: [...(a.args || [])],
    sessionId: str(a.sessionId), 'reuseSession': Boolean(a.reuseSession), catchUp: Boolean(job?.catchUp), timeoutSec: str(a.timeoutSec),
    overlap: str(job?.overlap), retryMax: str(job?.retry?.max), backoffSec: str(job?.retry?.backoffSec),
    description: str(job?.description),
  };
}

/** Names of required fields still empty (Save is disabled while non-empty). */
function editorMissing(v, isCreate) {
  const missing = [];
  if (!String(v.prompt).trim()) missing.push('prompt');
  if (isCreate && !String(v.cwd).trim()) missing.push('cwd');
  if (!isCreate && !String(v.alias).trim()) missing.push('alias');
  return missing;
}

/** JobCreateInput for POST /api/jobs?prepare=1 (optional blanks omitted so server defaults apply). */
function buildCreateBody(v, schedule) {
  const action = { kind: 'prompt', prompt: v.prompt, cwd: String(v.cwd).trim(), engine: v.engine };
  const args = cleanArgs(v.args);
  if (args.length) action.args = args;
  const session = String(v.sessionId).trim();
  if (session) action.sessionId = session;
  else if (v.reuseSession) action.reuseSession = true;
  const timeout = parseOptionalNumber(v.timeoutSec);
  if (typeof timeout === 'number') action.timeoutSec = timeout;
  const body = { schedule, action };
  if (v.catchUp && findScheduleKind(schedule?.kind)?.supportsCatchUp) body.catchUp = true;
  const alias = String(v.alias).trim();
  if (alias) body.alias = alias;
  const description = String(v.description).trim();
  if (description) body.description = description;
  if (v.overlap) body.overlap = v.overlap;
  const retry = {};
  const max = parseOptionalNumber(v.retryMax);
  if (typeof max === 'number') retry.max = max;
  const backoff = parseOptionalNumber(v.backoffSec);
  if (typeof backoff === 'number') retry.backoffSec = backoff;
  if (Object.keys(retry).length) body.retry = retry;
  return body;
}

/** JobPatchInput for PUT /api/jobs/:id?prepare=1: changed fields only; cleared optionals -> null. `schedule` comes from the schedule hook. */
function buildEditPatch(base, draft, schedule) {
  const patch = {};
  const action = {};
  if (draft.alias !== base.alias && String(draft.alias).trim()) patch.alias = String(draft.alias).trim();
  if (draft.description !== base.description) {
    const d = String(draft.description).trim();
    if (d) patch.description = d;
    else if (String(base.description).trim()) patch.description = null;
  }
  if (schedule !== undefined) patch.schedule = schedule;
  if (Boolean(draft.catchUp) !== Boolean(base.catchUp)) patch.catchUp = Boolean(draft.catchUp);
  if (draft.prompt !== base.prompt && String(draft.prompt).trim()) action.prompt = draft.prompt;
  if (draft.cwd !== base.cwd && String(draft.cwd).trim()) action.cwd = String(draft.cwd).trim();
  if (draft.engine !== base.engine && draft.engine) action.engine = draft.engine;
  const baseArgs = cleanArgs(base.args);
  const draftArgs = cleanArgs(draft.args);
  if (JSON.stringify(baseArgs) !== JSON.stringify(draftArgs)) action.args = draftArgs;
  const session = String(draft.sessionId).trim();
  if (session !== String(base.sessionId).trim()) action.sessionId = session || null;
  if (!session && draft.reuseSession !== base.reuseSession) action.reuseSession = Boolean(draft.reuseSession);
  if (String(draft.timeoutSec).trim() !== String(base.timeoutSec).trim()) {
    const t = parseOptionalNumber(draft.timeoutSec);
    if (t === undefined) action.timeoutSec = null;
    else if (t !== 'invalid') action.timeoutSec = t;
  }
  if (Object.keys(action).length) patch.action = { kind: 'prompt', ...action };
  if (draft.overlap !== base.overlap && draft.overlap) patch.overlap = draft.overlap;
  const retry = {};
  for (const [field, key] of [['retryMax', 'max'], ['backoffSec', 'backoffSec']]) {
    if (String(draft[field]).trim() === String(base[field]).trim()) continue;
    const n = parseOptionalNumber(draft[field]);
    if (typeof n === 'number') retry[key] = n;
  }
  if (Object.keys(retry).length) patch.retry = retry;
  return patch;
}
const INTERVAL_UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 };

/** Count + unit (s/m/h/d) -> seconds; null when the count is not a positive number. */
function everySecFromInterval(count, unit) {
  const text = String(count ?? '').trim();
  const n = Number(text);
  const mult = INTERVAL_UNIT_SECONDS[unit];
  if (!text || !Number.isFinite(n) || n <= 0 || !mult) return null;
  return n * mult;
}

/** Seconds -> the largest unit that divides evenly (falls back to seconds). */
function intervalFromEverySec(sec) {
  for (const unit of ['d', 'h', 'm']) {
    const mult = INTERVAL_UNIT_SECONDS[unit];
    if (sec >= mult && sec % mult === 0) return { count: String(sec / mult), unit };
  }
  return { count: String(sec), unit: 's' };
}

/** ISO instant -> datetime-local text (YYYY-MM-DDTHH:mm) in the browser's local time; '' when unparseable. */
function toLocalInputValue(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/**
 * Schedule kind registry: the single extension point for the schedule section (SP05 `after`, SP06 `webhook`,
 * SP10 catch-up add one entry / field descriptor; the form shell never branches on kind).
 * fields[]: { id, label, type: text|number|select|datetime-local, options?, placeholder?, hint?, required?, default? }
 * toSchedule(values) -> Schedule object, or null while incomplete; fromSchedule(schedule) -> values;
 * validate?(values) -> error text ('' = fine).
 */
const SCHEDULE_KINDS = [
  {
    kind: 'cron',
    supportsCatchUp: true,
    label: 'Cron expression',
    help: 'Cron: five-field expression in local time, e.g. 0 9 * * *',
    fields: [{ id: 'cron', label: 'Expression', type: 'text', required: true, placeholder: '0 9 * * *', hint: 'Fires in the machine local time zone' }],
    toSchedule: (v) => (String(v.cron ?? '').trim() ? { kind: 'cron', cron: v.cron.trim() } : null),
    fromSchedule: (s) => ({ cron: s.cron ?? '' }),
  },
  {
    kind: 'interval',
    supportsCatchUp: true,
    label: 'Every N units',
    help: 'Every N units: repeats at a fixed interval, optionally from a start time',
    fields: [
      { id: 'count', label: 'Every', type: 'number', required: true, placeholder: '30' },
      { id: 'unit', label: 'Unit', type: 'select', options: ['s', 'm', 'h', 'd'], default: 'm' },
      { id: 'startAt', label: 'Starting at (optional)', type: 'datetime-local' },
    ],
    toSchedule: (v) => {
      const everySec = everySecFromInterval(v.count, v.unit);
      if (everySec === null) return null;
      const schedule = { kind: 'interval', everySec };
      if (String(v.startAt ?? '').trim()) schedule.startAt = v.startAt.trim();
      return schedule;
    },
    fromSchedule: (s) => ({ ...intervalFromEverySec(s.everySec), startAt: s.startAt ? toLocalInputValue(s.startAt) : '' }),
    validate: (v) => (String(v.count ?? '').trim() && everySecFromInterval(v.count, v.unit) === null ? 'Interval must be a positive number' : ''),
  },
  {
    kind: 'one-shot',
    supportsCatchUp: true,
    label: 'One time',
    help: 'One time: runs once at a local date and time',
    fields: [{ id: 'runAt', label: 'Run at', type: 'datetime-local', required: true, hint: 'Local time, same as --at' }],
    toSchedule: (v) => (String(v.runAt ?? '').trim() ? { kind: 'one-shot', runAt: v.runAt.trim() } : null),
    fromSchedule: (s) => ({ runAt: toLocalInputValue(s.runAt) }),
  },
  {
    kind: 'after',
    label: 'After another job',
    help: 'After another job: runs when the upstream job finishes',
    fields: [
      { id: 'jobId', label: 'Upstream job', type: 'select', optionsFrom: 'jobs', required: true, hint: 'Runs when this job finishes' },
      { id: 'status', label: 'When upstream', type: 'select', options: ['success', 'failure', 'any'], default: 'success' },
    ],
    toSchedule: (v) => (String(v.jobId ?? '').trim() ? { kind: 'after', jobId: v.jobId.trim(), status: v.status || 'success' } : null),
    fromSchedule: (s) => ({ jobId: s.jobId ?? '', status: s.status ?? 'success' }),
  },
  {
    kind: 'webhook',
    label: 'Webhook',
    help: 'Webhook: runs when a relay channel (smee.io) delivers an event, or when you press Trigger now. Leave the relay blank for local-trigger-only',
    fields: [
      { id: 'relay', label: 'Relay URL', type: 'text', placeholder: 'https://smee.io/…', hint: 'Treat as a secret: anyone with the URL can trigger this job. Blank = local trigger only', button: { label: 'Create channel', act: 'create-relay' } },
      { id: 'secret', label: 'Secret', type: 'password', hint: 'Optional HMAC secret verifying x-hub-signature-256' },
    ],
    toSchedule: (v) => {
      const schedule = { kind: 'webhook' };
      if (String(v.relay ?? '').trim()) schedule.relay = v.relay.trim();
      if (String(v.secret ?? '').trim()) schedule.secret = v.secret.trim();
      return schedule;
    },
    fromSchedule: (s) => ({ relay: s.relay ?? '', secret: s.secret ?? '' }),
  },
];

/** Run-log trigger block: source, delivery id, receipt time, and the payload as collapsible pretty JSON (text fallback). */
function renderTriggerHtml(trigger) {
  const t = trigger || {};
  let payload = String(t.payload ?? '');
  try { payload = JSON.stringify(JSON.parse(payload), null, 2); } catch { /* not JSON: show as-is */ }
  const row = (label, value) => (value ? `<div><strong>${escHtml(label)}:</strong> ${escHtml(value)}</div>` : '');
  return `${row('Source', t.source)}${row('Delivery', t.deliveryId)}${row('Received', t.receivedAt)}`
    + (payload ? `<details class="trigger-payload"><summary>Payload</summary><pre class="log-pane">${escHtml(payload)}</pre></details>` : '');
}

/** Options for a select field: static strings, or `optionsFrom: 'jobs'` = every job except the one being edited (no self-trigger). */
function scheduleFieldOptions(f) {
  if (f.optionsFrom === 'jobs') {
    const jobs = (lastData?.jobs || []).filter((j) => j.id !== editorJobId);
    return [{ value: '', label: 'Select a job…' }, ...jobs.map((j) => ({ value: j.id, label: j.alias || j.id.slice(0, 8) }))];
  }
  return f.options.map((o) => ({ value: o, label: o }));
}

function findScheduleKind(id) {
  return SCHEDULE_KINDS.find((k) => k.kind === id);
}
/** Server `details` path (zod format() key path, dot-joined, array indexes dropped) -> form field id. */
const EDITOR_ERROR_PATHS = {
  alias: 'alias', description: 'description', schedule: 'schedule', overlap: 'overlap',
  'retry.max': 'retryMax', 'retry.backoffSec': 'backoffSec',
  'action.prompt': 'prompt', 'action.cwd': 'cwd', cwd: 'cwd', 'action.engine': 'engine', 'action.args': 'args',
  'action.sessionId': 'sessionId', 'action.reuseSession': 'reuseSession', 'action.timeoutSec': 'timeoutSec',
};

/** Walks zod `format()` details (`{_errors, key: {...}}`) plus flat `{field: 'message'}` entries into dotted paths. */
function collectErrorPaths(node, prefix, out) {
  if (!node || typeof node !== 'object') return;
  for (const [key, child] of Object.entries(node)) {
    if (key === '_errors') {
      if (Array.isArray(child) && child.length && prefix) out.push(prefix);
      continue;
    }
    const path = /^\d+$/.test(key) ? prefix : (prefix ? `${prefix}.${key}` : key);
    if (typeof child === 'string') out.push(path);
    else collectErrorPaths(child, path, out);
  }
}

/** Server error response -> { code, message, fields (form field ids to outline), folders (trust), runs (in-flight) }. */
function mapEditorError(status, body) {
  const error = body?.error;
  const code = error?.code || 'UNKNOWN';
  const details = error?.details;
  const fields = [];
  const add = (...ids) => { for (const id of ids) if (!fields.includes(id)) fields.push(id); };
  if (code === 'INVALID_CWD') add('cwd');
  else if (code === 'JOB_ALREADY_EXISTS') add('alias');
  else if (code === 'CWD_CHANGE_BREAKS_SESSION') add('cwd', 'sessionId', 'reuseSession');
  else if (code === 'VALIDATION_ERROR') {
    const paths = [];
    collectErrorPaths(details, '', paths);
    for (const path of paths) {
      const id = EDITOR_ERROR_PATHS[path] || EDITOR_ERROR_PATHS[path.split('.').slice(0, 2).join('.')] || EDITOR_ERROR_PATHS[path.split('.')[0]];
      if (id) add(id);
    }
  }
  return {
    code,
    message: error?.message || `Save failed (${status})`,
    fields,
    folders: Array.isArray(details?.folders) ? details.folders.map(String) : [],
    runs: Array.isArray(details?.runs) ? details.runs : [],
  };
}

/** Trust is offered only after TRUST_REQUIRED and only for engines whose adapter can trust folders. */
function shouldRevealTrust(mapped, meta, engine) {
  if (mapped.code !== 'TRUST_REQUIRED') return false;
  return Boolean((meta?.engines || []).find((e) => e.name === engine)?.supportsTrust);
}

/** Changing engine or directory invalidates a revealed trust prompt. */
function editorTrustKey(v) {
  return `${v.engine}\n${String(v.cwd).trim()}`;
}

function appendSaveOptions(url, opts) {
  let out = url;
  if (opts.trustFolder) out += '&trustFolder=1';
  if (opts.inFlight) out += `&inFlight=${encodeURIComponent(opts.inFlight)}`;
  return out;
}
// </editor-pure>

/**
 * Schedule section: kind select + field panel rendered purely from SCHEDULE_KINDS, with a debounced live preview.
 * render(container, job|null); collect(): Schedule or undefined (unchanged/none); isComplete(); isDirty().
 */
const editorScheduleHook = (() => {
  const PREVIEW_DEBOUNCE_MS = 400;
  let box = null;
  let kindId = SCHEDULE_KINDS[0].kind;
  let values = {};
  let baseline = '';
  let timer = null;
  let seq = 0;

  const kindDef = () => findScheduleKind(kindId);
  const defaultsFor = (def) => Object.fromEntries(def.fields.map((f) => [f.id, f.default ?? '']));
  const snapshot = () => JSON.stringify([kindId, values]);
  const currentSchedule = () => kindDef().toSchedule(values);

  function fieldHtml(f) {
    const id = `editor-sch-${f.id}`;
    const v = values[f.id] ?? '';
    const control = f.type === 'select'
      ? `<select id="${id}" data-sched-field="${escHtml(f.id)}">${scheduleFieldOptions(f).map((o) => `<option value="${escHtml(o.value)}"${o.value === v ? ' selected' : ''}>${escHtml(o.label)}</option>`).join('')}</select>`
      : `<input id="${id}" type="${f.type}" data-sched-field="${escHtml(f.id)}" value="${escHtml(v)}"${f.placeholder ? ` placeholder="${escHtml(f.placeholder)}"` : ''}${f.type === 'number' ? ' min="0" step="any"' : ''}${f.required ? ' required' : ''} autocomplete="off">`;
    const button = f.button ? ` <button type="button" class="btn" data-sched-act="${escHtml(f.button.act)}">${escHtml(f.button.label)}</button>` : '';
    return `<label for="${id}">${escHtml(f.label)}</label><div>${control}${button}${f.hint ? `<div class="editor-hint">${escHtml(f.hint)}</div>` : ''}</div>`;
  }

  function drawPanel() {
    box.querySelector('.editor-sched-panel').innerHTML = `<div class="editor-grid">${kindDef().fields.map(fieldHtml).join('')}</div>`;
  }

  /** "Create channel": the daemon follows the smee.io/new redirect (CORS blocks the browser). */
  async function createRelay(btn) {
    btn.disabled = true;
    try {
      const { res, data } = await postJson('/api/relay/new', {});
      if (!res.ok) throw new Error(data?.error?.message || `Create channel failed (${res.status})`);
      values.relay = data.url;
      drawPanel();
      showToast('Channel created. Treat the URL as a secret');
      schedulePreview();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  /** Catch-up checkbox: visible only for kinds with supportsCatchUp; hidden kinds clear it. */
  function syncCatchUp() {
    const label = box?.querySelector('.editor-catchup');
    if (!label) return;
    const supported = Boolean(kindDef().supportsCatchUp);
    label.hidden = !supported;
    if (!supported) label.querySelector('input').checked = false;
  }

  function setPreview(html, isError) {
    const el = box?.querySelector('.editor-preview');
    if (!el) return;
    el.classList.toggle('editor-preview-error', Boolean(isError));
    el.innerHTML = html;
  }

  async function postJson(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async function runPreview() {
    const mine = ++seq;
    const problem = kindDef().validate?.(values);
    if (problem) return setPreview(escHtml(problem), true);
    const schedule = currentSchedule();
    if (!schedule) return setPreview('', false);
    try {
      const { res, data } = await postJson('/api/schedules/preview', { schedule, n: 5 });
      if (mine !== seq) return;
      if (!res.ok) return setPreview(escHtml(data?.error?.message || 'Preview unavailable'), true);
      const times = Array.isArray(data.next) ? data.next : [];
      setPreview(times.length
        ? `<div class="editor-preview-title">Next ${times.length} runs (local time)</div><ul>${times.map((t) => `<li>${escHtml(new Date(t).toLocaleString())}</li>`).join('')}</ul>`
        : `<div class="editor-hint">${data.trigger ? 'Runs when the upstream job finishes (no scheduled times)' : 'No upcoming runs'}</div>`, false);
    } catch {
      if (mine === seq) setPreview('', false); // preview failure never blocks editing
    }
  }

  async function runValidate() {
    const mine = ++seq;
    const schedule = currentSchedule();
    if (!schedule) return;
    try {
      const { data } = await postJson('/api/schedules/validate', schedule);
      if (mine !== seq) return;
      if (data && data.ok === false) setPreview(escHtml(data.error || 'Invalid schedule'), true);
      else void runPreview();
    } catch { /* validation is advisory */ }
  }

  function schedulePreview() {
    clearTimeout(timer);
    timer = setTimeout(runPreview, PREVIEW_DEBOUNCE_MS);
  }

  function onField(e) {
    const id = e.target?.dataset?.schedField;
    if (!id) return;
    values[id] = e.target.value;
    schedulePreview();
  }

  function onKindChange(e) {
    const def = findScheduleKind(e.target.value);
    if (!def) return;
    kindId = def.kind;
    values = defaultsFor(def);
    drawPanel();
    syncCatchUp();
    setPreview('', false);
    schedulePreview();
  }

  return {
    render(container, job) {
      clearTimeout(timer);
      seq += 1;
      box = container;
      const def = (job && findScheduleKind(job.schedule?.kind)) || SCHEDULE_KINDS[0];
      kindId = def.kind;
      values = { ...defaultsFor(def), ...(job ? def.fromSchedule(job.schedule) : {}) };
      baseline = snapshot();
      box.innerHTML = `<div class="editor-grid"><label for="editor-sch-kind">Schedule</label><div><select id="editor-sch-kind" data-sched-kind>${SCHEDULE_KINDS.map((k) => `<option value="${escHtml(k.kind)}"${k.kind === kindId ? ' selected' : ''}>${escHtml(k.label)}</option>`).join('')}</select></div></div><div class="editor-sched-panel"></div><label class="editor-check editor-catchup"><input type="checkbox" data-editor-field="catchUp"${job?.catchUp ? ' checked' : ''}> Catch up missed run on daemon start</label><div class="editor-preview" aria-live="polite"></div><details class="editor-howto"><summary>How to schedule</summary><ul>${SCHEDULE_KINDS.map((k) => `<li>${escHtml(k.help || k.label)}</li>`).join('')}</ul></details>`;
      drawPanel();
      syncCatchUp();
      box.onclick = (e) => {
        const btn = e.target?.closest?.('[data-sched-act="create-relay"]');
        if (btn) void createRelay(btn);
      };
      box.oninput = onField;
      box.onchange = (e) => (e.target?.matches?.('[data-sched-kind]') ? onKindChange(e) : onField(e));
      box.addEventListener('focusout', (e) => {
        if (e.target?.dataset?.schedField) { clearTimeout(timer); void runValidate(); }
      });
      if (job) void runPreview();
    },
    collect() {
      if (!box || (editorJobId !== null && !this.isDirty())) return undefined;
      return currentSchedule() ?? undefined;
    },
    isComplete() {
      if (!box) return true;
      if (editorJobId !== null && !this.isDirty()) return true;
      return currentSchedule() !== null && !kindDef().validate?.(values);
    },
    isDirty() {
      return Boolean(box) && snapshot() !== baseline;
    },
  };
})();

const jobEditor = document.getElementById('job-editor');
const editorForm = document.getElementById('editor-form');
const editorSave = document.getElementById('editor-save');
const editorBanner = document.getElementById('editor-banner');
let editorMeta = null;
let editorJobId = null; // null = create
let editorBase = null; // form values at open (blank for create)
let editorBusy = false;
let editorReturnFocus = null;

const editorEl = (field) => editorForm.querySelector(`[data-editor-field="${field}"]`);

function editorField(label, field, controlHtml, hint) {
  const id = `editor-f-${field}`;
  return `<label for="${id}">${escHtml(label)}</label><div>${controlHtml.replace('<!--id-->', id)}${hint ? `<div class="editor-hint">${escHtml(hint)}</div>` : ''}</div>`;
}

function editorArgRow(value) {
  return `<div class="editor-arg-row"><input type="text" data-editor-field="args" aria-label="Argument" value="${escHtml(value)}"><button type="button" class="icon-btn" data-editor-act="remove-arg" aria-label="Remove argument">✕</button></div>`;
}

function renderEditorForm(values, isCreate) {
  const meta = editorMeta;
  const engines = (meta?.engines || []).map((e) => e.name);
  if (values.engine && !engines.includes(values.engine)) engines.push(values.engine);
  const opts = (list, sel) => list.map((o) => `<option value="${escHtml(o)}"${o === sel ? ' selected' : ''}>${escHtml(o)}</option>`).join('');
  const input = (field, type, value, extra = '') => `<input id="<!--id-->" type="${type}" data-editor-field="${field}" value="${escHtml(value)}" ${extra}>`;
  editorForm.innerHTML = `
    <div class="editor-grid">
      ${editorField('Alias', 'alias', input('alias', 'text', values.alias, `placeholder="${isCreate ? 'auto-generated' : ''}" autocomplete="off"${meta?.aliasPattern ? ` pattern="${escHtml(meta.aliasPattern)}"` : ''}`), 'kebab-case, e.g. nightly-report')}
      ${editorField('Prompt', 'prompt', `<textarea id="<!--id-->" data-editor-field="prompt" rows="5" required>${escHtml(values.prompt)}</textarea>`)}
    </div>
    <div id="editor-schedule" class="editor-schedule" data-editor-field="schedule"></div>
    <div class="editor-grid">
      ${editorField('Directory', 'cwd', input('cwd', 'text', values.cwd, 'required autocomplete="off" placeholder="/absolute/path"'), 'Absolute path the job runs in')}
      ${editorField('Runner', 'engine', `<select id="<!--id-->" data-editor-field="engine">${opts(engines, values.engine)}</select>`)}
      <label>Arguments</label>
      <div>
        <div id="editor-args" class="editor-args">${values.args.map(editorArgRow).join('')}</div>
        <button type="button" class="btn" data-editor-act="add-arg">+ Add argument</button>
      </div>
      ${editorField('Session id', 'sessionId', input('sessionId', 'text', values.sessionId, 'autocomplete="off"'), 'Resume this session on every run (implies reuse)')}
      <label>Reuse session</label>
      <div><label class="editor-check"><input type="checkbox" data-editor-field="reuseSession"${values.reuseSession ? ' checked' : ''}> Start a session and resume it on later runs</label></div>
      ${editorField('Timeout (sec)', 'timeoutSec', input('timeoutSec', 'number', values.timeoutSec, 'min="1" step="1"'), 'Blank = unbounded')}
      ${editorField('Overlap', 'overlap', `<select id="<!--id-->" data-editor-field="overlap">${opts(['skip', 'queue', 'cancel-previous'], values.overlap)}</select>`)}
      ${editorField('Retry max', 'retryMax', input('retryMax', 'number', values.retryMax, 'min="0" step="1"'))}
      ${editorField('Description', 'description', input('description', 'text', values.description, 'autocomplete="off"'))}
    </div>
    <details class="editor-advanced"><summary>Advanced</summary>
      <div class="editor-grid">
        ${editorField('Retry backoff (sec)', 'backoffSec', input('backoffSec', 'number', values.backoffSec, 'min="1" step="1"'), 'Delay between retries')}
      </div>
    </details>
    <div id="editor-trust" class="editor-trust" hidden>
      <label class="editor-check"><input type="checkbox" data-editor-field="trustFolderCheck"> <span id="editor-trust-label"></span></label>
      <div class="editor-hint">Lets Claude run in this folder without asking. Never granted unless you tick this box.</div>
    </div>`;
  editorScheduleHook.render(document.getElementById('editor-schedule'), isCreate ? null : editorLoadedJob);
  applyEditorState();
}

let editorLoadedJob = null;

function collectEditorValues() {
  const v = {};
  for (const f of ['alias', 'prompt', 'cwd', 'engine', 'sessionId', 'timeoutSec', 'overlap', 'retryMax', 'backoffSec', 'description']) {
    v[f] = editorEl(f)?.value ?? '';
  }
  v.reuseSession = Boolean(editorEl('reuseSession')?.checked);
  v.catchUp = Boolean(editorEl('catchUp')?.checked);
  v.args = [...editorForm.querySelectorAll('[data-editor-field="args"]')].map((i) => i.value);
  return v;
}

function editorDirty() {
  if (!editorBase) return false;
  const draft = collectEditorValues();
  return JSON.stringify(draft) !== JSON.stringify(editorBase) || editorScheduleHook.isDirty();
}

function applyEditorState() {
  const v = collectEditorValues();
  const reuse = editorEl('reuseSession');
  if (reuse) {
    reuse.disabled = v.sessionId.trim() !== '';
    if (reuse.disabled) reuse.checked = false;
  }
  const missing = editorMissing(v, editorJobId === null);
  editorSave.disabled = editorBusy || missing.length > 0 || !editorScheduleHook.isComplete();
}

function clearEditorFeedback() {
  editorBanner.hidden = true;
  editorBanner.textContent = '';
  editorForm.querySelectorAll('.field-error').forEach((el) => el.classList.remove('field-error'));
}

function showEditorError(message) {
  editorBanner.textContent = message;
  editorBanner.hidden = false;
}

async function loadEditorMeta() {
  const res = await fetch('/api/jobs/editor-meta');
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message || `GET /api/jobs/editor-meta failed (${res.status})`);
  editorMeta = body;
}

async function openEditor(jobId) {
  editorReturnFocus = document.activeElement;
  editorJobId = jobId || null;
  editorBase = null;
  editorBusy = false;
  editorLoadedJob = null;
  editorTrustShownKey = null;
  editorInflightRetry = null;
  clearEditorFeedback();
  clearEditorInflight();
  document.getElementById('editor-title').textContent = jobId ? 'Edit job' : 'New job';
  editorForm.innerHTML = '<p class="muted">Loading…</p>';
  editorSave.disabled = true;
  jobEditor.hidden = false;
  jobEditor.querySelector('.modal').focus();
  try {
    await loadEditorMeta();
    if (jobId) {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { headers: { 'Content-Type': 'application/json' } });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message || `GET /api/jobs/${jobId} failed (${res.status})`);
      editorLoadedJob = body;
      editorBase = jobToEditorValues(body);
    } else {
      editorBase = blankEditorValues(editorMeta);
    }
    renderEditorForm(editorBase, !jobId);
    editorForm.querySelector(jobId ? '[data-editor-field="prompt"]' : '[data-editor-field="alias"]')?.focus();
  } catch (err) {
    editorBase = null;
    editorForm.innerHTML = '';
    showEditorError(err.message);
  }
}

function closeEditor() {
  jobEditor.hidden = true;
  editorBase = null;
  editorJobId = null;
  if (editorReturnFocus && document.contains(editorReturnFocus)) editorReturnFocus.focus();
  editorReturnFocus = null;
}

/** Cancel / X / backdrop / Esc: dirty confirms with the SP03 string, clean closes immediately. */
function requestLeaveEditor() {
  if (editorBusy) return;
  if (editorDirty() && !window.confirm(DISCARD_MESSAGE)) return;
  closeEditor();
}

let editorTrustShownKey = null;
let editorInflightRetry = null;
const editorInflight = document.getElementById('editor-inflight');

function hideEditorTrust() {
  editorTrustShownKey = null;
  const box = document.getElementById('editor-trust');
  if (!box) return;
  box.hidden = true;
  const cb = box.querySelector('input');
  if (cb) cb.checked = false;
}

function showEditorTrust(folders) {
  const box = document.getElementById('editor-trust');
  if (!box) return;
  document.getElementById('editor-trust-label').textContent = `Trust this folder in Claude: ${folders.join(', ')}`;
  const cb = box.querySelector('input');
  cb.checked = false;
  box.hidden = false;
  editorTrustShownKey = editorTrustKey(collectEditorValues());
  cb.focus();
}

function clearEditorInflight() {
  editorInflight.hidden = true;
  editorInflight.innerHTML = '';
}

function showEditorInflight(runs) {
  const list = runs.map((r) => `<code>${escHtml(String(r.runId || r.id || '').slice(0, 8))}</code>`).join(', ');
  editorInflight.innerHTML = `
    <div>${escHtml(String(runs.length))} run(s) in flight${list ? `: ${list}` : ''}. How should this save proceed?</div>
    <div class="row">
      <button type="button" class="btn" data-editor-inflight="stop">Stop running jobs, then save</button>
      <button type="button" class="btn" data-editor-inflight="wait">Pause and wait for runs, then save</button>
      <button type="button" class="btn" data-editor-inflight="cancel">Cancel save</button>
    </div>`;
  editorInflight.hidden = false;
  editorInflight.querySelector('button')?.focus();
}

function outlineEditorFields(fields) {
  for (const id of fields) {
    const els = id === 'schedule'
      ? [document.getElementById('editor-schedule')]
      : [...editorForm.querySelectorAll(`[data-editor-field="${id}"]`)];
    els.forEach((el) => el?.classList.add('field-error'));
  }
  const first = fields.length ? (editorForm.querySelector(`[data-editor-field="${fields[0]}"]`) || document.getElementById('editor-schedule')) : null;
  first?.scrollIntoView?.({ block: 'center' });
}

/**
 * Server error -> UI state; edits are never cleared. `retry(opts)` re-sends with { trustFolder, inFlight }.
 * TRUST_REQUIRED reveals the (unchecked) trust box; RUNS_IN_FLIGHT shows the stop / wait / cancel panel.
 */
function editorHandleSaveError(res, body, retry) {
  const mapped = mapEditorError(res.status, body);
  if (mapped.code === 'RUNS_IN_FLIGHT') {
    editorInflightRetry = retry;
    showEditorInflight(mapped.runs);
    return;
  }
  showEditorError(mapped.message);
  if (mapped.code === 'TRUST_REQUIRED' && shouldRevealTrust(mapped, editorMeta, collectEditorValues().engine)) {
    showEditorTrust(mapped.folders);
    return;
  }
  outlineEditorFields(mapped.fields);
}

/** Success: toast, close, refresh the dashboard (re-renders an open drawer for the job). */
async function editorHandleSaveSuccess() {
  const created = editorJobId === null;
  closeEditor();
  showToast(created ? 'Job created' : 'Job updated');
  await loadDashboard().catch(() => {});
}

async function saveEditor(opts = {}) {
  if (editorBusy || !editorBase || editorSave.disabled) return;
  const draft = collectEditorValues();
  const schedule = editorScheduleHook.collect();
  let url;
  let method;
  let payload;
  if (editorJobId === null) {
    url = '/api/jobs?prepare=1';
    method = 'POST';
    payload = buildCreateBody(draft, schedule);
  } else {
    payload = buildEditPatch(editorBase, draft, schedule);
    if (Object.keys(payload).length === 0) {
      showToast('No changes to save');
      closeEditor();
      return;
    }
    url = `/api/jobs/${encodeURIComponent(editorJobId)}?prepare=1`;
    method = 'PUT';
  }
  const trusted = opts.trustFolder ?? Boolean(document.querySelector('#editor-trust:not([hidden]) input')?.checked);
  url = appendSaveOptions(url, { trustFolder: trusted, inFlight: opts.inFlight });
  clearEditorFeedback();
  clearEditorInflight();
  editorBusy = true;
  applyEditorState();
  if (opts.inFlight) {
    editorInflight.innerHTML = `<div>${opts.inFlight === 'wait' ? 'Paused; waiting for in-flight runs to finish, then saving…' : 'Stopping in-flight runs and saving…'}</div>`;
    editorInflight.hidden = false;
  }
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await res.json().catch(() => null);
    if (res.ok) {
      editorBusy = false;
      await editorHandleSaveSuccess(body);
      return;
    }
    editorHandleSaveError(res, body, (next) => saveEditor(next));
  } catch (err) {
    showEditorError(err.message || 'Save failed');
  } finally {
    editorBusy = false;
    if (!jobEditor.hidden) applyEditorState();
  }
}

function syncEditorTrust() {
  if (editorTrustShownKey !== null && editorTrustKey(collectEditorValues()) !== editorTrustShownKey) hideEditorTrust();
}
editorForm.addEventListener('input', (e) => {
  e.target.classList?.remove('field-error');
  e.target.closest?.('.field-error')?.classList.remove('field-error');
  syncEditorTrust();
  applyEditorState();
});
editorForm.addEventListener('change', () => { syncEditorTrust(); applyEditorState(); });
editorInflight.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-editor-inflight]');
  if (!btn) return;
  const choice = btn.dataset.editorInflight;
  const retry = editorInflightRetry;
  clearEditorInflight();
  if (choice === 'cancel' || !retry) return;
  void retry({ inFlight: choice });
});
editorForm.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-editor-act]');
  if (!btn) return;
  const list = document.getElementById('editor-args');
  if (btn.dataset.editorAct === 'add-arg') {
    list.insertAdjacentHTML('beforeend', editorArgRow(''));
    list.lastElementChild.querySelector('input').focus();
  } else if (btn.dataset.editorAct === 'remove-arg') {
    btn.closest('.editor-arg-row').remove();
  }
  applyEditorState();
});
editorSave.addEventListener('click', () => void saveEditor());
document.getElementById('editor-cancel').addEventListener('click', requestLeaveEditor);
document.getElementById('editor-close').addEventListener('click', requestLeaveEditor);
document.getElementById('btn-new-job').addEventListener('click', () => void openEditor(null));
document.getElementById('drawer-edit').addEventListener('click', () => { if (drawerJobId) void openEditor(drawerJobId); });
jobEditor.addEventListener('click', (e) => {
  if (e.target.id === 'job-editor') requestLeaveEditor();
});
jobEditor.addEventListener('keydown', (e) => trapTab(e, jobEditor.querySelector('.modal')));

// ── Paused state ────────────────────────────────────────────────────────────

function renderPaused(paused) {
  pausedState = Boolean(paused);
  document.getElementById('paused-badge').hidden = !pausedState;
  const btn = document.getElementById('btn-pause');
  btn.textContent = pausedState ? 'Resume' : 'Pause';
  btn.title = pausedState ? 'Resume the scheduler' : 'Pause the scheduler (no new runs start)';
}

async function refreshPaused() {
  try {
    const res = await fetch('/api/daemon/status');
    if (res.ok) renderPaused((await res.json()).paused);
  } catch { /* status is best-effort */ }
}

document.getElementById('btn-pause').addEventListener('click', async () => {
  try {
    const body = await apiAction('POST', pausedState ? '/api/daemon/resume' : '/api/daemon/pause');
    renderPaused(body?.paused);
    showToast(body?.paused ? 'Scheduler paused: no new runs will start' : 'Scheduler resumed');
  } catch (err) {
    showToast(err.message, true);
  }
});

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
  if (action === 'trigger-toggle') {
    const panel = document.querySelector('#drawer-body .drawer-trigger');
    if (panel) {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) panel.querySelector('textarea')?.focus();
    }
    return;
  }
  if (action === 'copy-relay' || action === 'trigger') {
    const run = action === 'copy-relay' ? copyRelayUrl : triggerJobNow;
    run(drawerJobId).catch((err) => showToast(err.message, true));
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
  if (!jobEditor.hidden) requestLeaveEditor();
  else if (!settingsModal.hidden) requestLeaveSettings();
  else if (!document.getElementById('log-modal').hidden) closeRunModal();
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
