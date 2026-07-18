# 02 — Ecosystem Research: Scheduling Libraries, Prior Art & Recommendations

> Generated: 2026-07-17 · Research window: 2024-2026  
> Purpose: Inform design of an open-source, platform-agnostic Node.js cron daemon with MCP server.

---

## Table of Contents

1. [Node.js Scheduling Libraries — 2024-2026 State of the Art](#1-nodejs-scheduling-libraries)
2. [Standalone Cron-Like Tools — Feature Mining](#2-standalone-cron-like-tools)
3. [Features Worth Borrowing → Concrete Proposals](#3-features-worth-borrowing)
4. [UX / CLI Conventions to Adopt](#4-ux--cli-conventions-to-adopt)
5. [Open-Source Cron Dashboards](#5-open-source-cron-dashboards)
6. [Distribution & Platform Notes](#6-distribution--platform-notes)
7. [Naming & npm Availability](#7-naming--npm-availability)
8. [Prior Art for Exposing Schedulers Over MCP](#8-prior-art-for-mcp)

---

## ⚠️ V2 AMENDMENT (2026-07-18) — read this first.

- **Final package name is `crontick`** (verified free on npm 2026-07-18). Skip §7 (naming shortlist) — decision locked. `@cronjs/*` scoped names, `cron-daemon`, `cronly` are all abandoned.
- **Ignore §3 M-6 (bearer auth on HTTP API)** — v1 has no HTTP MCP and no auth surface. The dashboard/CLI HTTP API binds to `127.0.0.1` only.
- **Feature borrows to include in v1**: `@daily/@reboot` aliases (M-1), persistent-timer / missed-run recovery (M-2), env-file support (M-3), overlap policy (M-4), `/health` + `/metrics` (M-5). Everything else moves to post-v1 backlog.
- **§8 (prior-art MCP servers)**: still relevant as competitive analysis; our positioning stays "self-hostable, cross-platform, MIT, dashboard-included, script-first, ships with a Copilot skill and marketplace plugin".
- Everything else — library survey, tool comparisons, UX conventions, dashboard ideas — remains authoritative.

---

## 1. Node.js Scheduling Libraries

### 1.1 Library Comparison Table

| Library | Weekly DLs (2025) | GitHub Stars | Last Release | Maintained? |
|---|---|---|---|---|
| `croner` | ~7 M | ~2,500 | Active (v9.x) | ✅ Yes |
| `node-cron` | ~8 M | ~3,200 | Active (v4.6.0) | ✅ Yes |
| `node-schedule` | ~4.5 M | ~9,200 | v2.1.1 (stable, slow updates) | ⚠️ Slow |
| `cron` (kelektiv) | ~5 M | ~9,000 | Active (v3.x) | ✅ Yes |
| `bree` | ~150 k/month | ~3,300 | Active | ✅ Yes |
| `agenda` | ~95 k | ~9,100 | Active | ✅ Yes |
| `bull` / `bullmq` | Very high | >14,000 | Active | ✅ Yes |
| `toad-scheduler` | ~500 k | ~600 | v3.1.0 | ✅ Active |
| `p-cron` | Minimal | <100 | Unknown | ❌ Unclear |

Sources: [npmtrends.com](https://npmtrends.com/croner-vs-later-vs-node-cron-vs-node-schedule), [betterstack.com scheduler guide](https://betterstack.com/community/guides/scaling-nodejs/best-nodejs-schedulers/), [npm-compare.com](https://npm-compare.com/cron,node-cron,node-schedule).

---

### 1.2 Per-Library Deep Dives

#### `croner` (Hexagon/croner)

- **Cron dialect:** 6-field (sec min hr dom mon dow) + optional year. Quartz-compatible. Supports `L` (last), `W` (weekday), `?`, ranges, steps. Does **not** natively support `@daily`/`@hourly` aliases.
- **Timezone/DST:** First-class IANA timezone support via `@date-fns/tz` (v9) / `luxon` internals. Schedules in target timezone; DST transitions produce correct wall-clock times (e.g., "8 AM" stays "8 AM" through spring/fall changes). Zero external deps for basic use.
- **Missed-run / catch-up:** **Not supported** by default. Croner is in-process/in-memory; if the process is down, runs are silently skipped. No "persistent" mode.
- **Overlap protection:** `protect: true` option skips a new fire if the previous callback is still running. Can also supply a custom protect callback that queues or alerts.
- **Persistence:** None. Purely in-memory.
- **Worker/process isolation:** None built-in. Runs callbacks in the calling process.
- **Notable features:**
  - `job.nextRun()` / `job.nextRuns(n)` — preview next N fire times (useful for our "dry-run" feature)
  - `job.currentRun()` — detect overlap condition
  - Works on Node, Deno, Bun, and browsers (zero deps, ESM+CJS)
  - `mutable` date objects for custom scheduling logic
  - TypeScript built-in

Sources: [croner npm](https://www.npmjs.com/package/croner), [croner GitHub](https://github.com/hexagon/croner).

---

#### `node-cron` (node-cron/node-cron)

- **Cron dialect:** 6-field (sec min hr dom mon dow). Supports `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`, `@hourly` aliases. Named months/weekdays (JAN, MON, etc.).
- **Timezone/DST:** `timezone` option using IANA strings. Internally uses system `Intl.DateTimeFormat` (no external lib). DST handling depends on OS Intl support.
- **Missed-run / catch-up:** None.
- **Overlap protection:** `scheduled` flag; does not fire if previous run is still ongoing (v4.x adds configurable overlap behavior).
- **Persistence:** None (in-memory).
- **Worker/process isolation:** Optional — jobs can be run in forked child processes (v4.x feature). Redis-backed distributed coordination (prevents duplicate fires across multiple Node instances).
- **Notable features:**
  - Redis-backed distributed locking — **steal this for our distributed mode**
  - Named weekdays/months
  - `@daily` etc. aliases — **implement these**
  - `task.start()`, `task.stop()` lifecycle

Sources: [node-cron npm](https://www.npmjs.com/package/node-cron), [node-cron GitHub](https://github.com/node-cron/node-cron).

---

#### `node-schedule` (node-schedule/node-schedule)

- **Cron dialect:** 6-field (sec min hr dom mon dow). Also accepts `RecurrenceRule` objects and `Date` objects for one-shot triggers.
- **Timezone/DST:** `tz` option via IANA string. Uses `luxon` for timezone math.
- **Missed-run / catch-up:** None.
- **Overlap protection:** None built-in.
- **Persistence:** None.
- **Worker/process isolation:** None.
- **Notable features:**
  - `RecurrenceRule` API — programmatic schedule construction without cron strings
  - One-shot `Date`-based scheduling (`.scheduleJob(date, fn)`)
  - `gracefulShutdown()` for clean process exit

Sources: [node-schedule npm](https://www.npmjs.com/package/node-schedule).

---

#### `cron` (kelektiv/node-cron)

- **Cron dialect:** 6-field (sec min hr dom mon dow). `CronJob` / `CronTime` classes. Supports `@yearly`, `@monthly`, `@weekly`, `@daily`, `@hourly`.
- **Timezone/DST:** `timeZone` option with IANA strings via `luxon`.
- **Missed-run / catch-up:** None.
- **Overlap protection:** None.
- **Persistence:** None.
- **Worker/process isolation:** Optional child_process execution via `onComplete` and shell-execution patterns.
- **Notable features:**
  - `CronTime` as standalone class — reusable schedule object
  - `job.fireOnTick()` for manual trigger
  - `runOnInit: true` — fires immediately on creation

Sources: [cron npm](https://www.npmjs.com/package/cron), [npm-compare.com](https://npm-compare.com/cron,node-cron,node-schedule).

---

#### `bree` (breejs/bree)

- **Cron dialect:** Cron strings + human-friendly strings (`every 5 minutes`, `at 10:15am`), interval numbers, `Date` objects.
- **Timezone/DST:** Timezone support via underlying cron parsing.
- **Missed-run / catch-up:** None.
- **Overlap protection:** Built-in — each job runs in its own worker; concurrent instances controlled via `hasSeconds` and worker lifecycle.
- **Persistence:** None (state lives in parent process).
- **Worker/process isolation:** ✅ **Best-in-class** — each job runs in a dedicated `worker_thread` (or `child_process`). Workers are fully isolated, sandboxed, gracefully cancellable, and support inter-process messaging.
- **Notable features:**
  - Worker thread isolation is the primary value proposition
  - `workerData` for passing context to workers
  - Plugin ecosystem
  - Graceful shutdown with worker drain
  - **Steal: isolate long-running jobs in a worker_thread**

Sources: [bree GitHub](https://github.com/breejs/bree), [bestofjs.org/bree](https://bestofjs.org/projects/bree).

---

#### `agenda` (agenda/agenda)

- **Cron dialect:** Human-readable strings (`every 5 minutes`, `every day at 10am`) via `agenda.every()`, plus `agenda.schedule()` for one-shots.
- **Timezone/DST:** Limited built-in; relies on MongoDB date math.
- **Missed-run / catch-up:** ✅ **Yes** — jobs have a `lastRunAt` and `nextRunAt` stored in MongoDB. On startup, agenda queries for overdue jobs and runs them.
- **Overlap protection:** `agenda.define(name, { lockLifetime, concurrency })` — distributed MongoDB-based locking.
- **Persistence:** ✅ **MongoDB** required. All jobs, schedules, and run state persisted.
- **Worker/process isolation:** None (callbacks in same process).
- **Notable features:**
  - Distributed lock via MongoDB — multi-instance safe
  - Job priority
  - Pause/resume per job
  - `agenda.now(name)` for immediate one-shot
  - Failed job detection and retry
  - **Steal: persistent nextRunAt tracking for missed-run recovery**

Sources: [agenda npm](https://www.npmjs.com/package/agenda), [appsignal.com agenda-vs-bull](https://blog.appsignal.com/2023/09/06/job-schedulers-for-node-bull-or-agenda.html).

---

#### `bull` / `bullmq` (taskforcesh/bullmq)

- **Cron dialect:** `repeat: { pattern: '0 * * * *' }` on job options — 5- or 6-field cron via `cron-parser`. Also `repeat: { every: ms }`.
- **Timezone/DST:** `tz` option in repeat.
- **Missed-run / catch-up:** Partial — Redis stores `nextMillis`; if the process is down, the next fire picks up when the worker reconnects. Does not backfill past fires.
- **Overlap protection:** `concurrency` option per queue/worker. `limiter` for rate limiting.
- **Persistence:** ✅ **Redis** required. All jobs, states, results persisted in Redis streams.
- **Worker/process isolation:** Queues + separate workers (separate processes).
- **Notable features:**
  - Job priorities, delays, retries with exponential backoff
  - `attempts` + `backoff` configuration
  - Rate limiting, concurrency, global pause
  - Dashboard (Bull Board)
  - **Steal: retry with backoff, global concurrency semaphore**

Sources: [bullmq docs](https://docs.bullmq.io/), [appsignal.com](https://blog.appsignal.com/2023/09/06/job-schedulers-for-node-bull-or-agenda.html).

---

#### `toad-scheduler` (kibertoad/toad-scheduler)

- **Cron dialect:** Interval-based only (`SimpleIntervalJob`). No cron strings.
- **Timezone/DST:** N/A (intervals are elapsed-time based).
- **Missed-run / catch-up:** None.
- **Overlap protection:** `preventOverrun: true` option.
- **Persistence:** None.
- **Worker/process isolation:** None.
- **Notable features:**
  - Zero dependencies, extremely lightweight
  - Browser-compatible
  - `AsyncTask` wrapper for async error propagation
  - **Not suitable as primary scheduler; useful for heartbeat/monitoring intervals**

Sources: [toad-scheduler npm](https://www.npmjs.com/package/toad-scheduler), [toad-scheduler GitHub](https://github.com/kibertoad/toad-scheduler).

---

#### `p-cron`

- **Status:** Minimal ecosystem presence; no meaningful npm download data; unclear if actively maintained.  
- **Verdict:** Do not use. Not production-ready.

---

### 1.3 Feature Matrix

| Feature | croner | node-cron | node-schedule | cron | bree | agenda | bullmq | toad-scheduler |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Seconds field | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| `@daily` aliases | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| IANA timezone | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ❌ |
| DST-safe | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ❌ |
| Overlap protection | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| Missed-run recovery | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ⚠️ | ❌ |
| Persistence | ❌ | ❌ | ❌ | ❌ | ❌ | MongoDB | Redis | ❌ |
| Worker isolation | ❌ | ⚠️ fork | ❌ | ❌ | ✅ threads | ❌ | ✅ proc | ❌ |
| Retries / backoff | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| Zero deps | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| TypeScript | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Multi-runtime | ✅ Deno/Bun | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ browser |

---

### 1.4 Recommendation: Keep `croner`?

**Yes — keep `croner` as the scheduling engine.**

Rationale:

1. **Best DST handling** of zero-dependency options — IANA timezone support with `@date-fns/tz` in v9.
2. **`nextRun()`/`nextRuns(n)` API** is exactly what we need for the "preview next N fires" dry-run feature.
3. **`protect` option** gives overlap protection out of the box.
4. **Runs on Node/Deno/Bun/browser** — aligns with our platform-agnostic goal.
5. **7M weekly downloads, actively maintained** — low abandonment risk.

What to borrow from others and build ourselves:
- `@daily`/`@hourly` alias expansion (trivial — preprocess input string)
- Persistence (our SQLite layer handles this already)
- Missed-run recovery (our daemon's startup logic must check `nextRunAt` vs. `now()`)
- Retry/backoff (implement in our run-execution layer, not the scheduler)

The only reason to switch would be if we needed MongoDB/Redis persistence baked in (agenda/bull) or worker-thread isolation per job (bree). Since our architecture uses SQLite + the OS process model (`child_process.spawn`), croner is the right fit.

---

## 2. Standalone Cron-Like Tools — Feature Mining

### 2.1 Unix cron / crontab

| Dimension | Detail |
|---|---|
| **Job definition** | Line in `crontab -e`: `min hr dom mon dow command`. System-wide in `/etc/cron.d/`. |
| **Persistence** | Definitions persist in crontab files; run history is **not** persisted — output goes to mail. |
| **Crash/restart & missed runs** | No catch-up. If system is down at scheduled time, the run is silently skipped. |
| **Overlap / retries / backoff** | None built-in. If a job runs longer than its interval, the next fire creates a new process in parallel. |
| **Isolation** | Each job is a new OS process with its own PID, inherits the cron daemon's limited environment. `USER` and `HOME` set; `PATH` is minimal. |
| **Logs & history** | Stderr/stdout mailed to `MAILTO`. `/var/log/cron` or `journalctl` for daemon events. |
| **Secrets** | Environment variables in crontab preamble (`KEY=value` lines). No vault integration. |
| **Distributed** | N/A — single host. |
| **Unique feature worth stealing** | `@reboot` (run on daemon start), `@hourly`/`@daily`/`@weekly`/`@monthly`/`@yearly` aliases; minimal `PATH` isolation teaches us to document our own PATH behavior. |

Source: `man 5 crontab`.

---

### 2.2 anacron

| Dimension | Detail |
|---|---|
| **Job definition** | `/etc/anacrontab`: `period delay job-id command` (period in days). |
| **Persistence** | Stores last-run timestamps in `/var/spool/anacron/<job-id>`. |
| **Crash/restart & missed runs** | ✅ **Core feature**: runs missed daily/weekly/monthly jobs on next boot with a configurable startup delay. |
| **Overlap / retries** | No overlap protection. No built-in retries. |
| **Isolation** | OS process. |
| **Logs** | Syslog. |
| **Unique feature** | `START_HOURS_RANGE` — only run jobs during certain hours. Randomized delay (`RANDOM_DELAY` global). **Steal: startup delay + "only run in time window"**. |

---

### 2.3 fcron

| Dimension | Detail |
|---|---|
| **Job definition** | Per-user `fcrontab` file: extended cron syntax + option flags like `&` (serial), `@` (run at boot), `%` (run once). |
| **Persistence** | Binary spool files track next scheduled time and last completion. |
| **Crash/restart & missed runs** | ✅ Runs missed jobs on next run with `runfreq` and `notuntil` semantics. Can skip if missed for too long (`maxjobruntime`). |
| **Overlap / retries** | `&` flag = serial (no overlap). `retries` + `retrydelay` per job. |
| **Isolation** | OS process. Per-user daemon. |
| **Logs** | Syslog + optional email. |
| **Unique features** | `bootrun` — run job at boot; `lavg` — load average threshold (don't run if system is busy); `runas` for different users; `nice`/`renice` level per job. **Steal: load-average gate; runas; per-job nice level**. |

---

### 2.4 systemd timers

| Dimension | Detail |
|---|---|
| **Job definition** | Two unit files: `.timer` (when) + `.service` (what). Declarative INI syntax. |
| **Persistence** | `Persistent=true` in `[Timer]` — timestamps stored in `/var/lib/systemd/timers/`. If a `Persistent=true` timer fires were missed (system down), it runs at next boot. |
| **Crash/restart & missed runs** | ✅ `Persistent=true` = anacron-like catch-up. `AccuracySec=` controls precision (default 1 min). |
| **Overlap / retries** | `RemainAfterElapse`, `OnUnitActiveSec` monotonic timers prevent overlap. No native retry; combine with `Restart=on-failure` in service. |
| **Isolation** | Full cgroup isolation: `MemoryLimit=`, `CPUQuota=`, `User=`, `Group=`, `WorkingDirectory=`, `EnvironmentFile=`, `Nice=`, `IOSchedulingClass=`. |
| **Logs** | `journalctl -u service-name.service` — structured, rotating, queryable. |
| **Secrets** | `EnvironmentFile=/path/to/.env`, integration with `systemd-creds` (encrypted secrets). |
| **Distributed** | N/A single host, but systemd-nspawn / Portable Services for containers. |
| **Unique features worth stealing** | `RandomizedDelaySec=` (jitter); `Persistent=true` (missed-run catch-up); `OnCalendar=` rich calendar expressions; `EnvironmentFile=`; cgroup resource limits; `OnBootSec=`+`OnUnitActiveSec=` for interval-from-last-run semantics. |

Source: [systemd.timer docs](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html).

---

### 2.5 launchd (macOS)

| Dimension | Detail |
|---|---|
| **Job definition** | `.plist` (XML property list) in `~/Library/LaunchAgents/` or `/Library/LaunchDaemons/`. Keys: `StartCalendarInterval`, `StartInterval`, `ProgramArguments`. |
| **Persistence** | Plist placement is persistent across reboots. `KeepAlive=true` restarts crashed daemons. |
| **Crash/restart & missed runs** | ❌ **No catch-up**. If system is asleep/off when `StartCalendarInterval` fires, the run is skipped until next scheduled time. |
| **Overlap** | ✅ Default — launchd will not start a second instance if one is already running. |
| **Isolation** | Full OS-level: `UserName`, `GroupName`, `WorkingDirectory`, `EnvironmentVariables`, `ProcessType` (Background/Standard/Adaptive/Interactive), `SoftResourceLimits`. |
| **Logs** | `StandardOutPath`/`StandardErrorPath` to redirect to log files. |
| **Unique features** | `ThrottleInterval` — minimum seconds between launches; `WatchPaths` — trigger on filesystem change (**steal: file-watch trigger**); `QueueDirectories` — trigger when directory has files; `Sockets` — socket activation. |

Source: [Apple launchd.plist man page](https://ss64.com/osx/launchd.plist.html), [Apple developer docs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).

---

### 2.6 Windows Task Scheduler

| Dimension | Detail |
|---|---|
| **Job definition** | XML task definition or GUI. Key elements: `<Triggers>` (time, event, logon, idle, network), `<Actions>` (Exec, COM, email, message), `<Settings>`. |
| **Persistence** | XML files in `%SystemRoot%\System32\Tasks\`. Survive reboot. |
| **Crash/restart & missed runs** | `<StartWhenAvailable>true</StartWhenAvailable>` = run as soon as possible if missed. |
| **Overlap** | `<MultipleInstancesPolicy>`: `IgnoreNew`, `Parallel`, `Queue`, `StopExisting`. |
| **Retries** | `<RestartOnFailure><Interval>PT5M</Interval><Count>3</Count>`. |
| **Isolation** | `<Principal>` — run as specific user/group, `RunLevel` (elevated), `LogonType`. `<EnvironmentVariables>` not native in XML but inherits calling user's env. |
| **Logs** | Windows Event Log, Task Scheduler history (enable `TaskScheduler/Operational` log). |
| **Secrets** | Credential store; password prompted on import; integration with LSASS. |
| **Unique features** | Event-based triggers (`<EventTrigger>` on Windows Event Log); `<IdleTrigger>` — run when system idle; `<RegistrationTrigger>` — run at task creation; `<NetworkSettings>` — only run on specific network. |

Source: [Microsoft Task Scheduler XML Schema](https://docs.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema).

---

### 2.7 Cronicle (Node.js)

- **Repo:** [jhuckaby/Cronicle](https://github.com/jhuckaby/Cronicle) — Node.js, MIT
- **Job definition:** Web UI + JSON API. Jobs have: `plugin` (script runner), `params`, schedule (cron or interval), timezone, `max_children` (concurrency), `category`.
- **Persistence:** JSON flat-file storage (or S3). Job run history stored.
- **Crash/restart & missed runs:** Cluster mode; leader election (Cronicle uses a `master` process concept); on restart, jobs that were queued will run. Catch-up of missed runs: configurable.
- **Overlap:** `max_children` per job; `max_jobs` per category — **this is the global semaphore pattern**.
- **Retries:** Manual only (no automatic retry built-in).
- **Isolation:** Plugins run as child processes; `cwd` configurable per job.
- **Logs:** Per-run log stored and viewable in web UI with live streaming. Log search, line count, download.
- **Secrets:** Not a first-class feature; relies on OS environment.
- **Distributed:** Multi-server cluster with auto leader election; jobs distributed to worker nodes by category.
- **Unique features:**
  - **Category-based global concurrency limits** (e.g., "only 3 DB jobs at once")
  - Real-time log streaming in the browser
  - Estimated finish time during job execution
  - Abort/kill running jobs from UI
  - Web-hooks for job events
  - Plugin architecture (shell, perl, node, etc.)

Source: [Cronicle GitHub README](https://github.com/jhuckaby/Cronicle/blob/master/docs/README.md).

---

### 2.8 Jobber (Go)

- **Repo:** [dshearer/jobber](https://github.com/dshearer/jobber)
- **Job definition:** Per-user YAML file `~/.jobber`:
  ```yaml
  jobs:
    BackupDB:
      cmd: /usr/bin/backup.sh
      time: 0 2 * * *
      onError: Backoff
  ```
- **Persistence:** YAML file persists definitions; run log persisted to disk.
- **Crash/restart:** Daemon restarts re-read jobfile; no catch-up of missed times.
- **Overlap:** Serial by default (one instance).
- **Retries / backoff:** ✅ `onError: Backoff` — exponential backoff retries until success; `onError: Continue` / `onError: Stop` also available.
- **Logs:** `jobber log` command shows per-job stdout/stderr history. JSON-record notification output.
- **Secrets:** OS user context; email/webhook notifications on failure.
- **Unique features:**
  - `Backoff` error policy with exponential delay — **steal this**
  - Per-user daemon isolation
  - `jobber test BackupDB` — dry-run a job immediately
  - Status reporting: `Good`, `Failed`, `Backoff`, `Paused`

Source: [Jobber GitHub](https://github.com/dshearer/jobber), [LinuxLinks Jobber](https://www.linuxlinks.com/jobber-run-commands-schedule/).

---

### 2.9 Nomad Periodic Jobs (HashiCorp)

| Dimension | Detail |
|---|---|
| **Job definition** | HCL `periodic { cron = "*/15 * * * * *" prohibit_overlap = true }` block inside Nomad job spec. |
| **Persistence** | Nomad state stored in Raft consensus; survives restarts. |
| **Crash/restart & missed runs** | ❌ No catch-up. Missed executions are not backfilled; only next scheduled time fires. |
| **Overlap** | `prohibit_overlap = true` prevents concurrent instances. |
| **Retries** | Job-level `reschedule` block: `attempts = 3`, `interval = "30m"`, `delay = "15s"`. |
| **Isolation** | Full container/VM isolation (Docker, exec, java, raw_exec drivers). Resource limits: `cpu`, `memory`, `disk`. |
| **Logs** | `nomad alloc logs <alloc-id>` — captures stdout/stderr. Log rotation built-in. |
| **Secrets** | Vault integration: `vault { policies = [...] }` block — jobs get dynamic short-lived Vault secrets. |
| **Distributed** | ✅ Multi-node cluster, leader election, job placement on any matching node. |
| **Unique features** | Vault secret injection at runtime; resource constraints; scheduling constraints (`constraint` blocks for OS/driver/hardware). |

Source: [Nomad periodic job spec](https://developer.hashicorp.com/nomad/docs/job-specification/periodic).

---

### 2.10 Kubernetes CronJob

| Dimension | Detail |
|---|---|
| **Job definition** | YAML manifest: `schedule: "0 * * * *"`, `jobTemplate.spec.template`. |
| **Persistence** | Kubernetes etcd stores all CronJob/Job state. |
| **Crash/restart & missed runs** | `startingDeadlineSeconds` — if missed for longer than this, skip. Default: unlimited (all missed fires attempted). `failedJobsHistoryLimit` / `successfulJobsHistoryLimit` control retention. |
| **Overlap** | `concurrencyPolicy: Allow | Forbid | Replace`. |
| **Retries** | Job-level `backoffLimit` (attempts); pod `restartPolicy`. |
| **Isolation** | Pod isolation: namespaces, resource requests/limits, service accounts, network policies. |
| **Logs** | `kubectl logs <pod>` — container stdout/stderr. |
| **Secrets** | Kubernetes Secrets / CSI volume mounts / external secrets operators. |
| **Distributed** | ✅ Inherently distributed across cluster. |
| **Unique features** | `timeZone` field (Kubernetes 1.27+); `suspend: true` to pause a CronJob; `successfulJobsHistoryLimit` for auto-cleanup. |

---

### 2.11 Chronos (Mesos — deprecated)

- Framework-level distributed cron over Apache Mesos. Supported ISO 8601 repeat intervals, DAG dependencies via `parents` field, container isolation.
- **Status:** Effectively deprecated; superseded by Kubernetes CronJob and Nomad. 
- **Feature worth noting:** ISO 8601 interval syntax (`R5/2024-01-01T00:00:00Z/PT1H` = repeat 5 times, every hour) — a more expressive format than cron strings.

---

### 2.12 Rundeck

| Dimension | Detail |
|---|---|
| **Job definition** | YAML/XML/Web UI. Jobs have steps, options, node targets, schedule, notifications. |
| **Persistence** | Database-backed (H2 embedded or external RDBMS). Full run history. |
| **Crash/restart** | DB-backed means history survives restart. Missed scheduled runs re-queued if configured. |
| **Overlap** | `Multiple Executions` flag; queue or reject. |
| **Retries / backoff** | Per-step retry with delay. Job-level retry count. |
| **Isolation** | Runs on target nodes via SSH/WinRM/agents. Sudo, RunAs user. |
| **Logs** | Rich UI log viewer: line-level timestamps, ANSI colors, download, search, filter by node. |
| **Secrets** | Key Storage (encrypted at rest). Plugins for HashiCorp Vault, AWS SSM. Per-job secret scoping. |
| **Distributed** | ✅ Node dispatcher — fan out to N nodes, per-node retry. |
| **Unique features** | Job step types (command, script, HTTP, node step, plugin); ACL policies per job group; webhooks as triggers; job option forms with validation. **Steal: ACL per job group, structured per-step logging**. |

---

### 2.13 Jenkins (scheduling aspect only)

- Cron trigger via `Build periodically` (5-field cron) and `Poll SCM`.
- `H` symbol ("Hash") in cron field — distributes load by hashing the job name, so not all jobs fire at :00. **Steal: hash-based jitter**.
- Missed runs: not caught up.
- Pipeline `input` step = human approval gate within a job.

---

### 2.14 Airflow (scheduling features only)

| Dimension | Detail |
|---|---|
| **Job definition** | Python DAG file: `schedule_interval`, `start_date`, `catchup` parameters. |
| **Persistence** | RDBMS (Postgres/MySQL) + DAG file on disk. Full run state in DB. |
| **Crash/restart & missed runs** | ✅ `catchup=True` (default) backfills all missed intervals from `start_date` to now on startup. |
| **Overlap** | `max_active_runs` per DAG; `depends_on_past` for ordered execution. |
| **Retries / backoff** | `retries=3`, `retry_delay=timedelta(minutes=5)`, `retry_exponential_backoff=True`. |
| **Isolation** | Celery/Kubernetes executors run tasks in separate workers/pods. |
| **Logs** | Per-task logs stored to disk/S3; viewable in UI with line numbers. |
| **Secrets** | Connections (encrypted in DB), Variables, Secrets Backends (Vault, AWS SSM, GCP Secret Manager). |
| **Unique features** | ✅ **Backfill** (`airflow dags backfill -s 2024-01-01 -e 2024-06-01 my_dag`); data-interval awareness; SLA miss alerts; `TriggerDagRunOperator` for DAG dependencies; `ExternalTaskSensor`. |

Source: [Airflow docs](https://airflow.apache.org/docs/).

---

### 2.15 Windmill

| Dimension | Detail |
|---|---|
| **Job definition** | Scripts (TypeScript, Python, Go, etc.) or Flows (visual DAG). Schedules created via UI or API with cron expressions + arguments. |
| **Persistence** | PostgreSQL backend. All runs, logs, schedules persisted. |
| **Crash/restart** | Survives restarts; persistent DB. No auto-catchup of missed runs. |
| **Overlap** | Concurrency limits per script/flow configurable. |
| **Retries** | Per-step retry policies in flows. |
| **Isolation** | Each job runs in an isolated sandbox (Docker, nsjail). Resource limits per workspace. |
| **Logs** | Per-run structured logs in UI; filterable by workspace/user/script. |
| **Secrets** | ✅ First-class: `Variable` (secret or plain), `Resource` (typed connections). Vault integration. |
| **Unique features** | Auto-generated UIs for script inputs; webhook triggers; event triggers (DB changes, S3 events); live flow visualization; version control (script content versioned in DB). **Steal: auto-generated argument UI for scheduled jobs**. |

Source: [Windmill docs](https://www.windmill.dev/docs/triggers).

---

### 2.16 Trigger.dev

| Dimension | Detail |
|---|---|
| **Job definition** | TypeScript SDK: `schedules.task(id, { cron: '0 * * * *' }, handler)`. |
| **Persistence** | Cloud-hosted DB + open-source self-host (PostgreSQL). Durable execution — job state checkpointed. |
| **Crash/restart** | ✅ Jobs survive crashes, redeploys. Checkpoint-resume semantics. |
| **Overlap** | Per-task concurrency limits + global queue. |
| **Retries** | Built-in with `maxAttempts`, exponential backoff. |
| **Isolation** | Each task runs in a separate container/process. |
| **Logs** | Real-time run logs in dashboard; step-level observability; alerting to Slack/email/webhook. |
| **Unique features** | Human-in-the-loop (`wait.for(input)`); long-running jobs (no timeout); AI workflow orchestration; replay failed runs. **Steal: "replay a specific failed run" button**. |

Source: [trigger.dev](https://trigger.dev/).

---

### 2.17 Inngest

| Dimension | Detail |
|---|---|
| **Job definition** | TypeScript/Python/Go SDK: `inngest.createFunction({ cron: '0 * * * *' }, handler)`. |
| **Persistence** | Managed cloud platform; durable execution engine. |
| **Crash/restart** | ✅ Step-level durability — each step independently retried, not the whole job. |
| **Overlap** | Per-function concurrency limits; per-tenant throttling; rate limiting. |
| **Retries** | Step-level independent retries with backoff. |
| **Unique features** | Fan-out: one event triggers N function instances; `concurrency.key` for per-entity concurrency (e.g., per-user limits); batching; event fan-out. **Steal: per-job-key concurrency limiting**. |

Source: [inngest.com docs](https://www.inngest.com/docs).

---

### 2.18 Temporal

| Dimension | Detail |
|---|---|
| **Job definition** | SDK (TypeScript/Go/Java/Python): `client.workflow.start(fn, { cronSchedule: '0 * * * *' })`. |
| **Persistence** | Temporal Server (Cassandra or PostgreSQL). Event sourcing — full workflow history. |
| **Crash/restart** | ✅ Full durability. Workflow continues from last event on worker restart. |
| **Overlap** | Workflow-level: one instance at a time via workflow ID. |
| **Retries** | Activity retry policy: `maximumAttempts`, `initialInterval`, `backoffCoefficient`, `maximumInterval`. Jitter with custom logic. |
| **Isolation** | Workers are separate processes/containers. Activities isolated. |
| **Unique features** | Deterministic replay of workflow history; `Signal` and `Query` for external interaction; child workflows; `SearchAttributes` for filtering in UI; timer durability (a `sleep(30 days)` actually survives restarts). **Steal: durable timer concept — our SQLite `nextRunAt` is a simplified version of this**. |

Source: [Temporal docs](https://docs.temporal.io/).

---

## 3. Features Worth Borrowing → Concrete Proposals

Priority tiers: **MUST** (v1.0) / **SHOULD** (v1.x) / **NICE** (future).

---

### MUST — Required for a Credible v1.0

---

#### M-1. Cron Aliases (`@daily`, `@hourly`, etc.)

| Field | Value |
|---|---|
| **Inspired by** | Unix cron, `node-cron`, `cron` (kelektiv) |
| **Description** | Pre-process alias strings before passing to croner, enabling `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`, `@hourly`, and our own `@reboot`. |
| **Implementation** | Add a `expandAlias(expr: string): string` utility called in `JobManager.create()` before passing to croner. Map: `@hourly → 0 * * * *`, `@daily → 0 0 * * *`, `@midnight → 0 0 * * *`, `@weekly → 0 0 * * 0`, `@monthly → 0 0 1 * *`, `@yearly/@annually → 0 0 1 1 *`. `@reboot` is a special sentinel that fires the job once on daemon start. Store the original alias in the DB `schedule` column; expand at runtime. |
| **Schema change** | None — `schedule` column already a TEXT; add `is_reboot BOOLEAN DEFAULT 0` or handle via alias check. |
| **Effort** | S (< 1 day) |

---

#### M-2. Persistent Timer Semantics (Missed-Run Recovery)

| Field | Value |
|---|---|
| **Inspired by** | systemd `Persistent=true`, anacron, agenda |
| **Description** | On daemon startup, query all enabled jobs where `next_run_at <= NOW()`. Fire each one immediately (with jitter if configured). Mark them "catch-up run" in the history. |
| **Implementation** | In `DaemonManager.start()`, after loading jobs: `const overdue = db.prepare('SELECT * FROM jobs WHERE enabled=1 AND next_run_at <= ?').all(Date.now())`. For each overdue job, if `job.catchup === true`, enqueue immediately. Add per-job `catchup BOOLEAN DEFAULT 0` and `catchup_window_ms INTEGER DEFAULT NULL` (null = always catch up; set a window, e.g. 3 600 000 = only if missed < 1 h). Update `next_run_at` via croner's `nextRun()` after firing. |
| **Schema change** | `ALTER TABLE jobs ADD COLUMN catchup INTEGER DEFAULT 0;` `ALTER TABLE jobs ADD COLUMN catchup_window_ms INTEGER DEFAULT NULL;` |
| **Effort** | S–M |

---

#### M-3. Environment File Support

| Field | Value |
|---|---|
| **Inspired by** | systemd `EnvironmentFile=`, Airflow Connections, Windmill Variables |
| **Description** | Per-job and global env file support. Load `.env`-format files whose key=value pairs are merged into the job's subprocess environment. |
| **Implementation** | Schema: `env_file TEXT` (path to file), `env JSON` (inline object). At run time in `JobRunner.spawn()`: parse file with `dotenv.parse(fs.readFileSync(job.env_file))`, merge with `job.env`, pass as `env: { ...process.env, ...jobEnv }` to `child_process.spawn`. For security, warn if `env_file` is world-readable. Never log env values. |
| **Schema change** | `ALTER TABLE jobs ADD COLUMN env_file TEXT;` `ALTER TABLE jobs ADD COLUMN env TEXT DEFAULT '{}';` |
| **Effort** | S |

---

#### M-4. Overlap Policy (configurable, not just boolean)

| Field | Value |
|---|---|
| **Inspired by** | Kubernetes CronJob `concurrencyPolicy`, Windows Task Scheduler `MultipleInstancesPolicy` |
| **Description** | Extend current boolean overlap protection to a named policy: `skip` (default — skip new fire if running), `queue` (buffer one fire, run after current completes), `replace` (kill current and start new), `allow` (parallel). |
| **Implementation** | `overlap_policy TEXT DEFAULT 'skip'` in DB. In `JobRunner`: before spawn, check `runs` table for active run with `job_id` and `status='running'`. Apply policy. For `queue`, store pending-fire count (max 1) in `jobs.queued_fire BOOLEAN`; after job completion, if `queued_fire=1`, fire immediately. |
| **Schema change** | `ALTER TABLE jobs ADD COLUMN overlap_policy TEXT DEFAULT 'skip';` `ALTER TABLE jobs ADD COLUMN queued_fire INTEGER DEFAULT 0;` |
| **Effort** | M |

---

#### M-5. Health Check Endpoint + Basic Metrics

| Field | Value |
|---|---|
| **Inspired by** | Kubernetes liveness/readiness probes, prom-client patterns |
| **Description** | Expose `GET /health` (liveness) and `GET /metrics` (Prometheus text format) on the existing HTTP API. |
| **Implementation** | `GET /health` returns `{ status: 'ok', uptime: process.uptime(), jobs: { total, enabled, running } }`. `GET /metrics` emits Prometheus text with counters: `cron_jobs_total`, `cron_runs_total{status}`, `cron_run_duration_seconds{job_id}`, `cron_daemon_uptime_seconds`. Use `prom-client` (MIT) or hand-roll the text format. |
| **API change** | New routes on existing HTTP server. |
| **Effort** | M |

---

#### M-6. Auth on the HTTP API (Bearer Token)

| Field | Value |
|---|---|
| **Inspired by** | Rundeck API tokens, Cronicle API keys, gh CLI auth |
| **Description** | Protect all API endpoints with a bearer token or Unix socket restriction. |
| **Implementation** | On first run, generate a random 32-byte token (`crypto.randomBytes(32).toString('hex')`), store in `config.db` or `~/.config/<name>/token`. Middleware checks `Authorization: Bearer <token>` header. Optionally bind to `127.0.0.1` only or Unix socket (`/tmp/<name>.sock`) for local-only access. CLI reads token from config file automatically. |
| **Effort** | M |

---

#### M-7. Alerting on Failure (Webhook + Email)

| Field | Value |
|---|---|
| **Inspired by** | Cronicle, Jobber, Rundeck, Trigger.dev |
| **Description** | Per-job or global alert on failure: HTTP webhook POST, and/or email via SMTP. |
| **Implementation** | After job completes with non-zero exit code, evaluate `job.on_failure` policy: `{ type: 'webhook', url: '...', body_template: '...' }` or `{ type: 'email', to: '...' }`. Send async. Log alert dispatch in `runs` table. Add `alert_config TEXT` JSON column to `jobs`. Global fallback in daemon config. |
| **Schema change** | `ALTER TABLE jobs ADD COLUMN alert_config TEXT;` |
| **Effort** | M |

---

### SHOULD — Target v1.x

---

#### S-1. Randomized Delay / Jitter (formalize existing)

| Field | Value |
|---|---|
| **Inspired by** | systemd `RandomizedDelaySec=`, anacron `RANDOM_DELAY` |
| **Description** | Formalize existing `jitter` field as `jitter_ms INTEGER` — add random delay (0 to jitter_ms) before each job execution to prevent thundering herd on shared resources. |
| **Implementation** | In `JobRunner.run()`: `const delay = job.jitter_ms ? Math.floor(Math.random() * job.jitter_ms) : 0; await sleep(delay);`. Record effective start time. Already partially present — just standardize the field name and document it. |
| **Schema change** | Rename/add `jitter_ms INTEGER DEFAULT 0`. |
| **Effort** | S |

---

#### S-2. Per-Job Working Directory & User

| Field | Value |
|---|---|
| **Inspired by** | systemd `WorkingDirectory=` + `User=`, fcron `runas`, Rundeck node `sudo` |
| **Description** | `cwd` already exists; add `run_as_user TEXT` — spawn child process as a different OS user (Unix only). |
| **Implementation** | In `child_process.spawn` options: `uid: os.userInfo(run_as_user).uid, gid: os.userInfo(run_as_user).gid`. Requires daemon running as root or with `CAP_SETUID`. On Windows, use `runas` via shell. Warn/skip gracefully on unsupported platforms. |
| **Schema change** | `ALTER TABLE jobs ADD COLUMN run_as_user TEXT;` |
| **Effort** | M |

---

#### S-3. Retry with Exponential Backoff

| Field | Value |
|---|---|
| **Inspired by** | Jobber `Backoff`, BullMQ retry policy, Airflow `retry_exponential_backoff`, Temporal activity retry |
| **Description** | On non-zero exit, automatically retry the job up to `max_retries` times with exponential backoff. |
| **Implementation** | `retry_config TEXT` JSON column: `{ max_retries: 3, initial_delay_ms: 5000, backoff_coefficient: 2, max_delay_ms: 300000 }`. After a failed run, schedule a "retry run" with `type='retry'` in the `runs` table. Use `setTimeout` for delay. Track `attempt` number. After exhausting retries, mark `status='failed'` and fire alert. |
| **Schema change** | `ALTER TABLE jobs ADD COLUMN retry_config TEXT;` `ALTER TABLE runs ADD COLUMN attempt INTEGER DEFAULT 1;` `ALTER TABLE runs ADD COLUMN run_type TEXT DEFAULT 'scheduled';` |
| **Effort** | M |

---

#### S-4. Log Rotation & Retention Policy

| Field | Value |
|---|---|
| **Inspired by** | systemd journal, Rundeck log retention, K8s `successfulJobsHistoryLimit` |
| **Description** | Auto-purge old run records and stored logs. Configurable per-job or globally. |
| **Implementation** | Global config: `log_retention_days INTEGER DEFAULT 30`, `log_retention_runs INTEGER DEFAULT 1000`. Daily cleanup job (internal, not user-visible): `DELETE FROM runs WHERE completed_at < ?` and prune log files older than N days. API endpoint `DELETE /api/runs?before=<iso-date>`. |
| **Effort** | S |

---

#### S-5. Job Templates

| Field | Value |
|---|---|
| **Inspired by** | Rundeck job options/templates, Windmill script versioning |
| **Description** | A "template" is a job definition without a schedule that can be instantiated multiple times with different parameters. |
| **Implementation** | Add `is_template BOOLEAN DEFAULT 0` and `template_id TEXT` to `jobs`. API: `POST /api/jobs { ...params, template_id: 'backup-template' }` — creates a new job inheriting template defaults, overriding provided fields. Dashboard shows templates separately. |
| **Schema change** | `ALTER TABLE jobs ADD COLUMN is_template INTEGER DEFAULT 0;` `ALTER TABLE jobs ADD COLUMN template_id TEXT;` |
| **Effort** | M |

---

#### S-6. Dry-Run / Preview Next N Fires

| Field | Value |
|---|---|
| **Inspired by** | croner `job.nextRuns(n)`, systemd `systemd-analyze calendar` |
| **Description** | CLI and API endpoint to preview the next N scheduled fire times for a job without executing it. |
| **Implementation** | `GET /api/jobs/:id/next-runs?count=10` — use `croner`'s `job.nextRuns(count, endDate)` to return array of ISO timestamps. CLI: `<daemon> jobs next-runs <id> --count 10`. Also available during job creation to validate schedule expressions. |
| **Effort** | S |

---

#### S-7. Event-Based Triggers (File Watch, HTTP Webhook)

| Field | Value |
|---|---|
| **Inspired by** | launchd `WatchPaths`, systemd `.path` units, Windmill event triggers |
| **Description** | Jobs can be triggered by filesystem events (file created/modified) or inbound HTTP webhooks, in addition to cron schedules. |
| **Implementation** | `trigger_type TEXT DEFAULT 'cron'` (enum: `cron`, `interval`, `webhook`, `file_watch`, `manual`). For `file_watch`: use `fs.watch()` or `chokidar` (MIT). For `webhook`: add `POST /api/webhooks/:job_id` endpoint that triggers immediate run. Store `trigger_config TEXT` JSON. |
| **Schema change** | `ALTER TABLE jobs ADD COLUMN trigger_type TEXT DEFAULT 'cron';` `ALTER TABLE jobs ADD COLUMN trigger_config TEXT;` |
| **Effort** | L |

---

#### S-8. Resource Limits (nice, ionice)

| Field | Value |
|---|---|
| **Inspired by** | systemd `Nice=`, `IOSchedulingClass=`; fcron `nice`; Nomad resource block |
| **Description** | Per-job CPU nice value and I/O scheduling class, applied to the child process. |
| **Implementation** | `nice_level INTEGER DEFAULT 0` (−20 to 19). On Linux: prepend `nice -n <level>` and `ionice -c <class>` to spawn command, or use `child_process.spawn` with the process priority API. `process_priority` on Windows via `process.setpriority()` (Node 10.12+). `io_nice TEXT` (idle/best-effort/realtime). |
| **Schema change** | `ALTER TABLE jobs ADD COLUMN nice_level INTEGER DEFAULT 0;` `ALTER TABLE jobs ADD COLUMN io_nice TEXT DEFAULT 'best-effort';` |
| **Effort** | M |

---

#### S-9. Snapshot / Export / Import

| Field | Value |
|---|---|
| **Inspired by** | Existing `sync` feature; Rundeck job export (YAML/XML); Windows Task Scheduler XML export |
| **Description** | `<daemon> export > jobs.json` and `<daemon> import < jobs.json` — full round-trip serialization of all job definitions (not run history). |
| **Implementation** | `GET /api/export` returns JSON array of job definitions (omit `id`, include all config fields). `POST /api/import` accepts same format; upsert by job `name`. CLI wraps these. Include schema version field for migration. |
| **Effort** | S |

---

#### S-10. Backfill (Run Schedule for Historical Window)

| Field | Value |
|---|---|
| **Inspired by** | Airflow backfill command, agenda's startup catch-up |
| **Description** | Replay all scheduled fire times for a job between two dates, executing each run sequentially. |
| **Implementation** | CLI: `<daemon> jobs backfill <id> --from 2024-01-01 --to 2024-06-30 [--dry-run]`. API: `POST /api/jobs/:id/backfill { from, to, dry_run }`. Compute all fire times in window using croner's `nextRuns()` iteration. Enqueue as `run_type='backfill'` runs, executed serially. |
| **Effort** | M |

---

### NICE — Future / Community Contributions

---

#### N-1. Dependencies Between Jobs (DAG-Lite)

| Field | Value |
|---|---|
| **Inspired by** | Airflow `ExternalTaskSensor`, Rundeck job steps, Temporal child workflows |
| **Description** | A job can declare `depends_on: [job_id_1, job_id_2]` — it fires only after those jobs successfully complete on the same logical date/run. |
| **Implementation** | `depends_on TEXT` (JSON array of job IDs). After each job completion, check if any waiting jobs have all dependencies satisfied for this run window. Topological sort to detect cycles on save. |
| **Effort** | L |

---

#### N-2. Global Concurrency Semaphore (Category-Based)

| Field | Value |
|---|---|
| **Inspired by** | Cronicle categories with `max_jobs`, Inngest `concurrency.key` |
| **Description** | Jobs in the same category share a concurrency limit (e.g., "only 3 DB jobs at once" across all job instances). |
| **Implementation** | `category TEXT`, `category_max_concurrency INTEGER`. Before spawning, count `SELECT count(*) FROM runs WHERE status='running' AND category=?`. If at limit, queue the fire (respect `overlap_policy`). |
| **Effort** | M |

---

#### N-3. Auth — Unix Socket Mode

| Field | Value |
|---|---|
| **Inspired by** | Docker socket, pg socket auth |
| **Description** | Optionally bind the HTTP API to a Unix domain socket instead of TCP, providing OS-level access control (file permissions). |
| **Effort** | S |

---

#### N-4. Multi-Tenant / Namespacing

| Field | Value |
|---|---|
| **Inspired by** | Kubernetes namespaces, Windmill workspaces |
| **Description** | Partition jobs into named namespaces. API tokens scoped to a namespace. Useful for shared daemon installations. |
| **Effort** | L |

---

#### N-5. Signing Job Files (Supply-Chain)

| Field | Value |
|---|---|
| **Inspired by** | sigstore/cosign, npm provenance |
| **Description** | Export/import format includes a detached signature (sigstore bundle) over the job JSON. `import` verifies signature against a trusted public key or Sigstore transparency log. |
| **Effort** | L |

---

#### N-6. Distributed Leader Election (HA Daemon)

| Field | Value |
|---|---|
| **Inspired by** | Cronicle cluster mode, Nomad Raft, BullMQ Redis lock |
| **Description** | Two daemon instances elect a leader via Redis/etcd/SQLite WAL. Only leader fires cron jobs; follower takes over on leader failure. |
| **Note** | Out of scope for v1; document as a future architecture. SQLite WAL+`better-sqlite3`'s `exclusive` transaction could serve as a simple single-host "leader lock". |
| **Effort** | XL |

---

#### N-7. CLI UX from `at`, `batch`, `run-parts`, `fcron`

- **`at` inspiration:** `<daemon> run-at "2025-01-01 09:00" -- /usr/bin/backup.sh` — one-shot at wall time
- **`batch` inspiration:** `<daemon> run-when-idle -- heavy-script.sh` — execute when load average drops below threshold (tie to `lavg` feature)
- **`run-parts` inspiration:** `<daemon> jobs add --run-parts /etc/cron.daily` — schedule all executables in a directory as separate jobs
- **`fcron` inspiration:** `%bootrun` equivalent = `@reboot`; `&serial` = `overlap_policy: skip`

---

## 4. UX / CLI Conventions to Adopt

### 4.1 Survey of Modern CLIs

| CLI | Primary pattern | Notable conventions |
|---|---|---|
| `kubectl` | `kubectl <verb> <resource> [name] [flags]` | `get`/`describe`/`logs`/`exec`/`apply`/`delete`/`edit`; `-o json\|yaml\|wide`; `--watch` |
| `gh` | `gh <resource> <verb> [args]` | `gh job list`, `gh run view`, human-friendly table output, `--json` for scripting |
| `nomad` | `nomad <resource> <verb>` | `nomad job run`, `nomad job status`, `nomad alloc logs` |
| `docker` | `docker <noun> <verb>` | `docker container ls`, `docker logs`, `docker exec -it`, `docker inspect` |
| `git` | `git <verb> [resource]` | Porcelain vs plumbing; aliases for common combos |
| `bun` | `bun <verb>` | `bun run`, `bun add`, short flags |
| `deno` | `deno <verb>` | `deno run`, `deno task`, `deno info` |

### 4.2 Recommended Verb Set

Use **resource-first, then verb** (gh/nomad style) since our primary noun is `job`:

```
<daemon> jobs list              # Table of all jobs (id, name, schedule, status, last-run)
<daemon> jobs add [options]     # Create a new job (interactive prompt if no args)
<daemon> jobs describe <id>     # Full details of one job (all fields)
<daemon> jobs edit <id>         # Open job in $EDITOR as JSON/YAML, save on close
<daemon> jobs delete <id>       # Remove job (prompt for confirmation)
<daemon> jobs enable <id>       # Enable a disabled job
<daemon> jobs disable <id>      # Disable without deleting
<daemon> jobs run <id>          # Trigger immediate manual run
<daemon> jobs logs <id>         # Show recent run history + last output
<daemon> jobs next-runs <id>    # Preview next N scheduled fires
<daemon> jobs backfill <id>     # Backfill historical window
<daemon> jobs export            # Export all jobs to stdout (JSON)
<daemon> jobs import            # Import jobs from stdin (JSON)

<daemon> runs list [--job <id>] # List all run records
<daemon> runs describe <run-id> # Full detail of one run
<daemon> runs logs <run-id>     # Full stdout/stderr for a run

<daemon> daemon start           # Start the background daemon
<daemon> daemon stop            # Gracefully stop daemon
<daemon> daemon status          # Is daemon running? PID, uptime, version
<daemon> daemon restart         # Stop + start

<daemon> config set <key> <val> # Set daemon configuration
<daemon> config get [key]       # Show configuration
<daemon> config edit            # Open config in $EDITOR
```

### 4.3 Flag Conventions

| Pattern | Recommendation |
|---|---|
| Output format | `--output / -o` with values: `table` (default), `json`, `yaml`, `csv` |
| Filtering | `--status running\|completed\|failed`, `--since <iso>`, `--limit N` |
| Non-interactive | `--yes / -y` to skip confirmation prompts |
| Color | `--no-color` / `NO_COLOR` env var |
| Config file | `--config <path>` or `$DAEMON_CONFIG` env var |
| Verbose | `--verbose / -v`, `--debug` |
| Daemon connection | `--socket <path>` or `--port <n>` (default from config) |

### 4.4 Exit Codes

Follow POSIX conventions: `0` success, `1` general error, `2` usage error. Add `3` = daemon not running, `4` = job not found. Document in `--help`.

---

## 5. Open-Source Cron Dashboards

### 5.1 Dashboard Feature Survey

| Tool | URL | Notable UI Features |
|---|---|---|
| Cronicle | [github.com/jhuckaby/Cronicle](https://github.com/jhuckaby/Cronicle) | Real-time log streaming, live estimated finish time, per-category views, job abort button, multi-server view |
| Trigger.dev | [app.trigger.dev](https://trigger.dev/) | Step-level execution timeline, replay button, Slack/webhook alert config, run search/filter |
| Windmill | [windmill.dev](https://www.windmill.dev/) | Flow visualization (DAG), auto-generated input forms, live log streaming, workspace isolation |
| Healthchecks.io | [healthchecks.io](https://healthchecks.io/) | Status badges, timeline graphs per check, "last ping" / "next expected ping", incident history |
| Bull Board | [npm: @bull-board/api](https://github.com/felixmosh/bull-board) | Queue depth charts, job retry button, failed job inspector, Redis queue metrics |

### 5.2 Top 10 UI Features to Add to Our Dashboard

1. **Real-time log streaming** — WebSocket or SSE stream for `stdout`/`stderr` of a running job. User can watch progress live. *(Cronicle, Trigger.dev)*

2. **Run timeline / Gantt view** — Horizontal timeline showing when each job ran, how long it took, and whether it succeeded. Helps spot patterns, drift, and overlap visually. *(Cronicle)*

3. **Next scheduled fires panel** — Live-updating table showing the next N fire times for each enabled job (use croner's `nextRuns()`). *(Healthchecks.io "next expected ping")*

4. **Status badges per job** — Color-coded `RUNNING`, `OK`, `FAILED`, `SKIPPED`, `OVERDUE` badges on the job list. *(Healthchecks.io)*

5. **Replay / retry button** — One-click "run this job again" from the run detail view, with the same env/config. *(Trigger.dev)*

6. **Run duration histogram** — Sparkline or mini bar-chart per job showing historical run durations over last 30 runs. Surfaces performance regressions. *(Bull Board)*

7. **Global activity feed** — Reverse-chronological list of all job starts/completions/failures across all jobs — the "recent events" stream. *(Cronicle main screen)*

8. **Failure rate percentage** — Per-job: `success / total` ratio shown as a percentage badge. Alert if drops below configurable threshold. *(Healthchecks.io)*

9. **Log search** — Full-text search across stored run output. Useful for debugging flaky jobs. *(Rundeck)*

10. **Inline schedule editor** — Click on a cron expression in the UI to open a visual cron builder (cron expression → human-readable description, and vice versa). *(Windmill, Cronicle)*

---

## 6. Distribution & Platform Notes

### 6.1 How systemd-timer, launchd, and Task Scheduler Jobs Are Distributed as OSS on npm

**pm2** is the gold standard:
- Ships a Node.js process manager on npm (`npm i -g pm2`, MIT)
- `pm2 startup` detects the init system (systemd, upstart, launchd, Windows service) and emits the correct install command
- `pm2 save` serializes current process list to JSON; this list is restored on system startup
- Source: [pm2 startup docs](https://pm2.keymetrics.io/docs/usage/startup/)
- **Lesson:** Detect init system at install time; emit platform-specific instructions for the user to run (don't run them automatically — requires root/admin).

**forever** (npm, MIT):
- Pre-dates pm2; uses `forever-monitor` internally
- No startup integration beyond a `forever start` command; relies on external init

**nodemon** (npm, MIT):
- Development-only; no startup integration

**Reference implementations to study:**
- `pm2/lib/API/Startup.js` — detects `systemd`/`launchd`/`sysvinit`/Windows and generates the appropriate install unit
- `node-auto-launch` (Teamwork, MIT) — npm package that writes to Windows Registry (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`), macOS `LaunchAgents` plist, and Linux XDG autostart `.desktop` file. Clean, well-tested, 0 runtime deps.

### 6.2 Cross-Platform Autostart Libraries on npm

| Library | Platform Support | Mechanism | License | Weekly DLs | Notes |
|---|---|---|---|---|---|
| `node-auto-launch` | Win/mac/Linux | Registry / plist / XDG | MIT | ~100k | Best cross-platform; Electron-focused |
| `pm2 startup` | Win/mac/Linux/FreeBSD | systemd / launchd / Windows Service | MIT (core) | Very high | Overkill for embedding; study the detection logic |
| `auto-launch` (Teamwork fork) | Win/mac/Linux | Same as above | MIT | ~50k | Same family as node-auto-launch |

**Our current implementation** uses Windows `HKCU\...\Run` registry. To extend cross-platform:
1. Use `node-auto-launch` for user-session autostart (GUI/Electron-like use)
2. Or hand-roll: detect `process.platform`, write appropriate artifact:
   - `win32`: Registry via `reg add` shell call
   - `darwin`: Write `~/Library/LaunchAgents/<name>.plist`
   - `linux`: Write `~/.config/systemd/user/<name>.service` + `~/.config/systemd/user/<name>.timer`, then `systemctl --user enable --now <name>.timer`

### 6.3 Platform-Specific Considerations

| Platform | Autostart mechanism | Daemon supervision | Log location |
|---|---|---|---|
| Windows | `HKCU\...\Run` (user login) or Windows Service (NSSM) | Windows SCM | `%APPDATA%\<name>\logs\` |
| macOS | `~/Library/LaunchAgents/<name>.plist` | launchd | `~/Library/Logs/<name>/` |
| Linux (systemd) | `~/.config/systemd/user/<name>.service` | systemd user unit | `journalctl --user -u <name>` |
| Linux (non-systemd) | `~/.config/autostart/<name>.desktop` or rc.local | supervise/runit | `~/.local/share/<name>/logs/` |

---

## 7. Naming & npm Availability

### 7.1 Candidates Checked

| Name | npm Status (July 2025) | Notes |
|---|---|---|
| `cron` | ❌ **Taken** (kelektiv/node-cron, 5M DL/wk) | Too generic; name collision with top-10 package |
| `@cronjs/core` | ✅ **Appears available** | Scoped — requires owning `cronjs` org on npm. Clean, descriptive. |
| `cronjs` | ⚠️ **Likely available** (no major package) | Unscoped; short; may conflict with future packages |
| `xcron` | ✅ **Likely available** | "x" prefix overused; not memorable |
| `cron-daemon` | ✅ **Likely available** | Descriptive but hyphenated; longer to type |
| `nodecron` | ⚠️ Unclear | May conflict with `nodecron.com` (node-cron's marketing site) — avoid |
| `cronly` | ✅ **Appears available** | Short, memorable, but "cronly" has no clear meaning |

Sources: [sindresorhus/npm-name](https://github.com/sindresorhus/npm-name), npm search results.

> **Important:** Verify availability immediately before publishing with `npx npm-name <candidate>`. Names can be claimed at any time.

### 7.2 Shortlist with Tradeoffs

| Rank | Name | Pros | Cons |
|---|---|---|---|
| 🥇 1 | `@cronjs/core` | Scoped (safe from squatting), extensible org (`@cronjs/mcp`, `@cronjs/cli`), clear meaning, npm search-friendly | Requires creating `cronjs` npm org; scoped packages need explicit `--access public` on publish |
| 🥈 2 | `cron-daemon` | Immediately communicates what it is; no squatting risk; `cron-daemon start/stop` reads naturally | Hyphenated, harder to type; SEO competes with generic "cron daemon" searches |
| 🥉 3 | `cronly` | Short, memorable, .io domain likely available | Meaning opaque to newcomers; no SEO value; could be confused with "lonely" |
| 4 | `xcron` | Short | "x" prefix means nothing; no SEO; easily forgotten |

### 7.3 Recommendation

**Use `@cronjs/core` as the main package**, with:
- `@cronjs/cli` — standalone CLI binary
- `@cronjs/mcp` — MCP server module
- `@cronjs/dashboard` — web UI (if separated)
- `cronjs` (unscoped) — thin re-export shim for discoverability

This mirrors the pattern used by `@aws-sdk/*`, `@octokit/*`, `@tanstack/*`.

---

## 8. Prior Art for Exposing Schedulers Over MCP

### 8.1 Existing MCP Cron/Scheduler Servers (as of July 2025)

#### `jolks/mcp-cron`

- **URL:** [github.com/jolks/mcp-cron](https://github.com/jolks/mcp-cron)
- **License:** AGPL-3.0
- **Language:** TypeScript (Node.js)
- **Transport:** stdio + HTTP/SSE
- **Persistence:** SQLite
- **Tools exposed:**
  - `create_task` — create cron/shell/AI task
  - `list_tasks` — list all tasks
  - `delete_task` — remove task
  - `run_task` — immediate trigger
  - `get_task_history` — execution log
- **Notable:** Can route tasks to local LLM (Ollama) or remote AI (Anthropic). Multi-instance safe via SQLite.
- **Lesson:** Our MCP server should at minimum expose these same 5 tool primitives.

Sources: [jolks/mcp-cron GitHub](https://github.com/jolks/mcp-cron), [lobehub MCP listing](https://lobehub.com/mcp/jolks-mcp-cron), [mcpmarket.com](https://mcpmarket.com/server/mcp-cron).

---

#### `PhialsBasement/scheduler-mcp`

- **URL:** [github.com/PhialsBasement/scheduler-mcp](https://github.com/PhialsBasement/scheduler-mcp)
- **License:** MIT
- **Language:** Python
- **Tools exposed:** create/list/delete jobs (shell, API call, AI content generation, reminders), get execution history, desktop notifications
- **Notable:** Demonstrates that a scheduler MCP can be non-Node — our TypeScript implementation will have a UX advantage in JS/TS shops.

Source: [PhialsBasement/scheduler-mcp](https://github.com/PhialsBasement/scheduler-mcp), [Glama MCP listing](https://glama.ai/mcp/servers/PhialsBasement/scheduler-mcp).

---

#### `@cronicorn/mcp-server`

- **URL:** [npmjs.com/@cronicorn/mcp-server](https://www.npmjs.com/package/@cronicorn/mcp-server)
- **Auth:** OAuth 2.0 device code flow (for cloud-hosted Cronicorn service)
- **Tools exposed:** create/list/pause/unpause/delete cron jobs, view job history
- **Prompts:** Slash-command prompts for onboarding, job migration from classic cron
- **Notable:** Demonstrates how to combine OAuth with MCP for cloud-hosted schedulers. Our self-hosted approach will use bearer token instead.

Source: [npmjs.com/@cronicorn/mcp-server](https://www.npmjs.com/package/@cronicorn/mcp-server).

---

#### `friendlygeorge/cron-scheduler-mcp-server`

- **URL:** [mcpservers.org listing](https://mcpservers.org/servers/friendlygeorge/cron-scheduler-mcp-server)
- **License:** MIT
- **Features:** Advanced retry logic, structured observability, persistent logging.

---

### 8.2 Awesome MCP Lists — Scheduler Section

- [github.com/modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) — Official registry. No first-party scheduler as of July 2025.
- [pomerium.com/blog/best-mcp-servers-2025](https://www.pomerium.com/blog/best-model-context-protocol-mcp-servers-in-2025) — Curated list; jolks/mcp-cron listed.
- [mcpservers.org](https://mcpservers.org) — Community registry; several scheduler entries.

### 8.3 Our MCP Server Design Recommendations

Based on the prior art, our `@cronjs/mcp` server should expose:

```typescript
// Recommended MCP tool definitions

tools: [
  // Job CRUD
  { name: 'create_job',     description: 'Create a new cron/interval/one-shot job' },
  { name: 'list_jobs',      description: 'List all jobs with current status' },
  { name: 'get_job',        description: 'Get full details of a specific job' },
  { name: 'update_job',     description: 'Update job fields (schedule, command, env, etc.)' },
  { name: 'delete_job',     description: 'Delete a job by ID or name' },
  { name: 'enable_job',     description: 'Enable a disabled job' },
  { name: 'disable_job',    description: 'Disable a job without deleting it' },

  // Execution
  { name: 'run_job',        description: 'Trigger an immediate run of a job' },
  { name: 'abort_job',      description: 'Kill a currently running job' },

  // Observability
  { name: 'get_run_history', description: 'Get recent run records for a job' },
  { name: 'get_run_logs',   description: 'Get stdout/stderr for a specific run' },
  { name: 'get_next_runs',  description: 'Preview next N scheduled fire times' },

  // Daemon
  { name: 'daemon_status',  description: 'Get daemon health, uptime, and metrics' },
]
```

**Authentication:** Bearer token passed via MCP `Authorization` header or as a tool input parameter. Do not hardcode tokens; read from environment variable `CRONJS_TOKEN`.

**Differentiation from existing tools:**
- Native SQLite (no Redis/MongoDB dependency)
- First-class cross-platform support (Windows + macOS + Linux)
- `@reboot` / missed-run recovery built-in
- Export/import (sync) built-in
- Single npm install, zero infra required

---

## Appendix A: Quick-Reference Cron Aliases

| Alias | Expansion | Meaning |
|---|---|---|
| `@yearly` / `@annually` | `0 0 1 1 *` | Once a year, midnight, Jan 1 |
| `@monthly` | `0 0 1 * *` | Once a month, midnight, 1st |
| `@weekly` | `0 0 * * 0` | Once a week, midnight Sunday |
| `@daily` / `@midnight` | `0 0 * * *` | Once a day, midnight |
| `@hourly` | `0 * * * *` | Once an hour, at :00 |
| `@reboot` | *(special)* | Once on daemon start |

---

## Appendix B: Overlap Policy Decision Matrix

| Scenario | Recommended policy |
|---|---|
| Short idempotent job (e.g., health check) | `skip` |
| Long batch job, must complete each run | `skip` |
| Real-time data poller, stale runs useless | `replace` |
| Event-driven job, no drops allowed | `queue` |
| Independent, stateless, embarrassingly parallel | `allow` |

---

## Appendix C: Suggested SQLite Schema Additions (consolidated)

```sql
-- Add to existing jobs table
ALTER TABLE jobs ADD COLUMN catchup            INTEGER  DEFAULT 0;
ALTER TABLE jobs ADD COLUMN catchup_window_ms  INTEGER  DEFAULT NULL;
ALTER TABLE jobs ADD COLUMN env_file           TEXT     DEFAULT NULL;
ALTER TABLE jobs ADD COLUMN env                TEXT     DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN overlap_policy     TEXT     DEFAULT 'skip';
ALTER TABLE jobs ADD COLUMN queued_fire        INTEGER  DEFAULT 0;
ALTER TABLE jobs ADD COLUMN alert_config       TEXT     DEFAULT NULL;
ALTER TABLE jobs ADD COLUMN jitter_ms          INTEGER  DEFAULT 0;
ALTER TABLE jobs ADD COLUMN run_as_user        TEXT     DEFAULT NULL;
ALTER TABLE jobs ADD COLUMN retry_config       TEXT     DEFAULT NULL;  -- JSON
ALTER TABLE jobs ADD COLUMN nice_level         INTEGER  DEFAULT 0;
ALTER TABLE jobs ADD COLUMN io_nice            TEXT     DEFAULT 'best-effort';
ALTER TABLE jobs ADD COLUMN is_template        INTEGER  DEFAULT 0;
ALTER TABLE jobs ADD COLUMN template_id        TEXT     DEFAULT NULL;
ALTER TABLE jobs ADD COLUMN trigger_type       TEXT     DEFAULT 'cron';
ALTER TABLE jobs ADD COLUMN trigger_config     TEXT     DEFAULT NULL;  -- JSON
ALTER TABLE jobs ADD COLUMN category           TEXT     DEFAULT NULL;
ALTER TABLE jobs ADD COLUMN depends_on         TEXT     DEFAULT NULL;  -- JSON array

-- Add to existing runs table
ALTER TABLE runs ADD COLUMN attempt            INTEGER  DEFAULT 1;
ALTER TABLE runs ADD COLUMN run_type           TEXT     DEFAULT 'scheduled';
-- run_type: scheduled | manual | backfill | retry | catchup | reboot

-- New table: categories
CREATE TABLE IF NOT EXISTS categories (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  max_concurrent INTEGER DEFAULT NULL,
  description    TEXT,
  created_at     INTEGER NOT NULL
);

-- New table: config
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO config VALUES ('log_retention_days', '30');
INSERT OR IGNORE INTO config VALUES ('log_retention_runs', '1000');
INSERT OR IGNORE INTO config VALUES ('api_token_hash', '');
```

---

*Document version: 1.0 — July 2025*  
*Research sources cited inline throughout. All download/star figures are approximate as of research date.*