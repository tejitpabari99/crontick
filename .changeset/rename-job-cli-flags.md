---
"crontick": minor
---

Job CLI flags: `jobs new` and `jobs update` rename `--engine` to `--runner` and add `-a` as the short form of `--alias` (the alias flag keeps its name). The old `--engine` switch now fails as an unknown option, including through engine-argument passthrough. CLI `--every` also accepts `s`, `m`, `h`, and `d` duration suffixes while bare numbers remain seconds.
