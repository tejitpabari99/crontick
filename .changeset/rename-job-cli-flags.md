---
"crontick": minor
---

Rename the `jobs new` and `jobs update` CLI switches from `--alias` to `--name` and from `--engine` to `--runner`. The old switches now fail as unknown options, including through engine-argument passthrough. CLI `--every` also accepts `s`, `m`, `h`, and `d` duration suffixes while bare numbers remain seconds.
