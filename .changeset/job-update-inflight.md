---
"crontick": minor
---

Updating a job with runs in flight now needs an explicit choice: library/MCP `inFlight: 'stop' | 'wait'` on `updateJob` / `crontick_job_update`, CLI `jobs update --stop-running | --wait-running` (a terminal prompts when neither is given), HTTP `PUT /api/jobs/:id?inFlight=`. `stop` cancels the job's runs (no retry, queued runs dropped); `wait` pauses only that job, applies after its runs finish, then resumes it. With runs in flight and no choice the call fails with `RUNS_IN_FLIGHT` listing them.
