---
"crontick": minor
---

Replace the CLI `-C, --cwd <dir>` option with `--dir <path>` on `jobs new`/`jobs update`. `-C` and `--cwd` are now unknown options (also after `--`). The stored `cwd` field, MCP and `--file` input are unchanged.
