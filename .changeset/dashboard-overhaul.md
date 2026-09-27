---
"crontick": patch
---

Overhaul the dashboard web UI: the jobs table now shows a job `Alias` column and a
copyable GUID `ID` column (the `Enabled` column is dropped) plus a right-aligned
actions cell with enable/disable and delete icon buttons (disable and delete prompt
for confirmation). Clicking a job row filters the runs list to that job. The recent
runs section gains a server-side "Filter Job" dropdown, a client-side status filter,
and a time/duration sort control. Run rows now show the full run id and session id
(each with a copy button) and open a log modal that splits Output (stdout + crontick
streams) from Error (stderr + the run's recorded error), each independently scrollable.
The stale `crontick dashboard data --runs-limit` hint in the dashboard runsLimit
validation errors is replaced with guidance to provide a positive integer.
