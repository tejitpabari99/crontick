# 0030: Forward unknown long options to prompt engines

- Status: Accepted
- Date: 2026-09-28

## Context

Prompt engines add options independently of crontick. A fixed CLI mapping would need a crontick release for every engine flag, including permission and budget controls. Claude's `--output-format` and `--settings` are already controlled by crontick's adapter, so user overrides would corrupt result parsing or completion tracking.

## Decision

`jobs new` and `jobs update` accept unknown long options. Each option, and its next token when that token is not flag-shaped, is stored verbatim in `action.args`. Options before or after `--` are accepted, and the original argument order is preserved. The existing `--arg` and `--` sources remain mutually exclusive with each other; unknown-option passthrough is an independent source. All paths use the same reserved-argument validation, which now also rejects `--output-format` and `--settings` (including `=value` forms).

Crontick adds no permission flag by default. Jobs may opt into engine-specific permissions through argument passthrough. The removed `--job-env-file` CLI option remains rejected; job environment files still use the job schema or library API.

## Consequences

New engine options need no crontick CLI release. Invalid engine-specific options may be stored and will be reported by the engine when a run starts. Crontick-managed options fail at job creation or update.
