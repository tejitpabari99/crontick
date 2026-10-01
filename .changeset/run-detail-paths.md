---
'crontick': minor
---

Run detail shows the final answer, error and stderr plus the full log file and Claude transcript paths as plain text (dashboard with Copy buttons, `runs get` as labelled lines). A path whose file is missing is flagged `file not found`; `getRun` / `GET /api/runs/:id` gain `logFileExists` and `transcriptExists`.
