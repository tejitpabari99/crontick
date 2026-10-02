---
"crontick": patch
---

`--session-id` now resumes any existing Claude session, including one started outside crontick: resuming relies on the session transcript existing on disk, not on a prior completed crontick run for the job. An explicit `sessionId` implies reuse (every run resumes it), so a redundant `reuseSession` is dropped silently and the job requires `overlap: skip`. A job is now auto-disabled after 3 consecutive failed runs (the last run's error notes `AUTO_DISABLED`); a successful run or re-enabling the job resets the count.
