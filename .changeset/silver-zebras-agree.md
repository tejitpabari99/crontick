---
"crontick": patch
---

Improve EOF-truncated JSON diagnostics for shared file reads:

- `crontick new --file`, `crontick update --file`, `crontick import`, and config read/validate now always report an end-of-input parse position for truncated JSON.
- When truncation leaves an obvious unfinished construct, the diagnostic now names the missing value, closing bracket, or closing brace alongside the existing expected-shape guidance.
