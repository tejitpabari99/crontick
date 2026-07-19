'use strict';

const BASE = '';

let jobs = [];
let runs = [];
let currentPage = 'jobs';

async function apiFetch(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function pollHealth() {
  const badge = document.getElementById('health-badge');
  const versionEl = document.getElementById('version-info');
  try {
    const h = await apiFetch('GET', '/health');
    if (h && h.ok) {
      badge.textContent = `✓ up ${formatDuration(h.uptimeSec)}`;
      badge.className = 'badge badge-ok';
      if (versionEl) {
        versionEl.textContent = `v${h.version} · pid ${h.pid} · node ${h.node} · ${h.jobs.total} jobs`;
      }
    } else {
      badge.textContent = '✗ unhealthy';
      badge.className = 'badge badge-error';
    }
  } catch {
    badge.textContent = '✗ unreachable';
    badge.className = 'badge badge-error';
  }
}

function formatDuration(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

async function loadJobs() {
  jobs = (await apiFetch('GET', '/api/jobs')) || [];
  renderJobs();
}

function renderJobs() {
  const tbody = document.getElementById('jobs-tbody');
  if (!tbody) return;
  tbody.innerHTML = jobs.map((j) => `
    <tr>
      <td><a href="#" class="link" data-job="${escHtml(j.id)}">${escHtml(j.id)}</a></td>
      <td>${escHtml(j.description || '—')}</td>
      <td><code>${escHtml(scheduleLabel(j.schedule))}</code></td>
      <td>
        <label class="toggle">
          <input type="checkbox" ${j.enabled ? 'checked' : ''} data-toggle="${escHtml(j.id)}">
        </label>
      </td>
      <td id="last-status-${escHtml(j.id)}">—</td>
      <td>
        <button class="btn" data-run-now="${escHtml(j.id)}">▶ Run</button>
        <button class="btn btn-danger" data-delete="${escHtml(j.id)}">✕</button>
      </td>
    </tr>
  `).join('');
}

function scheduleLabel(schedule) {
  if (!schedule) return '?';
  if (schedule.kind === 'cron') return schedule.cron + (schedule.tz ? ` (${schedule.tz})` : '');
  if (schedule.kind === 'interval') return `every ${schedule.everySec}s`;
  if (schedule.kind === 'one-shot') return `once at ${schedule.runAt}`;
  return schedule.kind;
}

async function loadRuns() {
  const filterJobId = document.getElementById('runs-filter')?.value || '';
  const filterStatus = document.getElementById('runs-status-filter')?.value || '';
  const qs = new URLSearchParams({ limit: '100' });
  if (filterJobId) qs.set('jobId', filterJobId);
  runs = (await apiFetch('GET', `/api/runs?${qs}`)) || [];
  if (filterStatus) runs = runs.filter((r) => r.status === filterStatus);
  renderRuns();
}

function renderRuns() {
  const tbody = document.getElementById('runs-tbody');
  if (!tbody) return;
  tbody.innerHTML = runs.map((r) => `
    <tr>
      <td><code>${escHtml(r.id.slice(0, 12))}…</code></td>
      <td>${escHtml(r.jobId)}</td>
      <td class="status-${r.status}">${escHtml(r.status)}</td>
      <td>${new Date(r.startedAt).toLocaleString()}</td>
      <td>${r.durationMs != null ? `${r.durationMs}ms` : '—'}</td>
      <td><button class="btn" data-view-logs="${escHtml(r.id)}">Logs</button></td>
    </tr>
  `).join('');
}

function openDrawer(title, content) {
  document.getElementById('drawer-title').textContent = title;
  document.getElementById('drawer-content').innerHTML = content;
  document.getElementById('drawer').classList.add('open');
  document.getElementById('overlay').classList.add('active');
}

function closeDrawer() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('overlay').classList.remove('active');
}

async function openJobDrawer(jobId) {
  const job = await apiFetch('GET', `/api/jobs/${encodeURIComponent(jobId)}`);
  const jobRuns = (await apiFetch('GET', `/api/runs?jobId=${encodeURIComponent(jobId)}&limit=20`)) || [];
  const runsHtml = jobRuns.map((r) => `
    <tr>
      <td class="status-${r.status}">${r.status}</td>
      <td>${new Date(r.startedAt).toLocaleString()}</td>
      <td>${r.durationMs != null ? `${r.durationMs}ms` : '—'}</td>
      <td><button class="btn" data-view-logs="${escHtml(r.id)}">Logs</button></td>
    </tr>
  `).join('');
  openDrawer(`Job: ${jobId}`, `
    <h3>Definition</h3>
    <pre>${escHtml(JSON.stringify(job, null, 2))}</pre>
    <h3 style="margin-top:16px">Recent Runs (last 20)</h3>
    <table>
      <thead><tr><th>Status</th><th>Started</th><th>Duration</th><th></th></tr></thead>
      <tbody>${runsHtml}</tbody>
    </table>
  `);
}

async function openLogsDrawer(runId) {
  const logs = await apiFetch('GET', `/api/runs/${encodeURIComponent(runId)}/logs`);
  const text = Array.isArray(logs) ? logs.map((l) => l.data).join('') : String(logs);
  openDrawer(`Logs: ${runId.slice(0, 12)}…`, `
    <pre id="log-pre">${escHtml(text)}</pre>
    <button class="btn" id="btn-tail-logs" data-run-id="${escHtml(runId)}">↓ Stream (SSE)</button>
  `);
}

function openCreateModal() {
  document.getElementById('modal-create').classList.add('open');
}

function closeCreateModal() {
  document.getElementById('modal-create').classList.remove('open');
  document.getElementById('form-error').textContent = '';
  document.getElementById('form-create').reset();
}

async function handleCreateJob(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = fd.get('id');
  const cron = fd.get('cron');
  const script = fd.get('script');
  const shell = fd.get('shell');
  const timeout = fd.get('timeout');
  const overlap = fd.get('overlap');
  const retry = fd.get('retry');
  const description = fd.get('description');

  if (!id || !cron || !script) {
    document.getElementById('form-error').textContent = 'ID, cron, and script are required.';
    return;
  }

  const body = {
    id,
    description: description || undefined,
    schedule: { kind: 'cron', cron },
    action: {
      kind: 'script',
      script,
      shell,
      timeoutSec: timeout ? parseInt(timeout, 10) : undefined,
    },
    overlap,
    retry: retry ? { max: parseInt(retry, 10), backoffSec: 30 } : undefined,
  };

  const result = await apiFetch('POST', '/api/jobs', body);
  if (result && result.error) {
    document.getElementById('form-error').textContent = JSON.stringify(result.error);
    return;
  }
  closeCreateModal();
  await loadJobs();
}

function showPage(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach((el) => el.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');
  document.querySelector(`[data-page="${page}"]`)?.classList.add('active');
  if (page === 'runs') void loadRuns();
  if (page === 'jobs') void loadJobs();
}

document.addEventListener('click', async (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;

  const navPage = target.dataset?.page;
  if (navPage) {
    showPage(navPage);
    return;
  }

  const jobId = target.dataset?.job;
  if (jobId) {
    e.preventDefault();
    await openJobDrawer(jobId);
    return;
  }

  const runNow = target.dataset?.runNow;
  if (runNow) {
    await apiFetch('POST', `/api/jobs/${encodeURIComponent(runNow)}/run`);
    setTimeout(() => void loadRuns(), 500);
    return;
  }

  const del = target.dataset?.delete;
  if (del) {
    if (confirm(`Delete job "${del}"? This cannot be undone.`)) {
      await apiFetch('DELETE', `/api/jobs/${encodeURIComponent(del)}`);
      await loadJobs();
    }
    return;
  }

  const viewLogs = target.dataset?.viewLogs;
  if (viewLogs) {
    await openLogsDrawer(viewLogs);
    return;
  }

  const tailRun = target.dataset?.runId;
  if (tailRun && target.id === 'btn-tail-logs') {
    const pre = document.getElementById('log-pre');
    if (pre) {
      const es = new EventSource(`/api/runs/${encodeURIComponent(tailRun)}/logs/stream`);
      es.onmessage = (ev) => {
        const d = JSON.parse(ev.data);
        if (d.done) {
          es.close();
          return;
        }
        pre.textContent += d.data || '';
        pre.scrollTop = pre.scrollHeight;
      };
    }
    return;
  }

  if (target.id === 'drawer-close' || target.id === 'overlay') {
    closeDrawer();
    return;
  }

  if (target.id === 'btn-create-job') {
    openCreateModal();
    return;
  }
  if (target.id === 'modal-cancel') {
    closeCreateModal();
    return;
  }

  if (target.id === 'btn-refresh') {
    if (currentPage === 'jobs') await loadJobs();
    else await loadRuns();
  }
});

document.addEventListener('change', async (e) => {
  const target = e.target;
  if (!(target instanceof HTMLInputElement)) return;
  const toggleId = target.dataset?.toggle;
  if (toggleId) {
    const endpoint = target.checked ? 'enable' : 'disable';
    await apiFetch('POST', `/api/jobs/${encodeURIComponent(toggleId)}/${endpoint}`);
    await loadJobs();
  }
});

document.addEventListener('submit', (e) => {
  if (e.target instanceof HTMLFormElement && e.target.id === 'form-create') {
    void handleCreateJob(e);
  }
});

void pollHealth();
setInterval(() => void pollHealth(), 5000);
void loadJobs();

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
