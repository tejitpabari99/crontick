---
"crontick": minor
---

Dashboard job editor: create jobs with the new **+** button and edit them from the row pencil or details drawer. The form has parity with `jobs new`/`jobs update` (schedule kinds with live next-fire preview, runner, directory, session, timeout, overlap, retry, description), shows server errors with edits kept, offers a Claude folder-trust checkbox when needed, and asks stop/wait when the job has runs in flight. Adds daemon HTTP support: `POST /api/jobs?prepare=1` and `PUT /api/jobs/:id?prepare=1` (shared normalization with the CLI), `trustFolder=1`, and `GET /api/jobs/editor-meta`.
