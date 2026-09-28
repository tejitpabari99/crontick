# 0031: Rename job CLI flags to name and runner

- Status: Accepted
- Date: 2026-09-28

## Context

The job CLI used `--alias` and `--engine` for two common inputs. The Claude
engine PRD calls for `--name` and `--runner` to match the intended command
shape. The generic engine-argument passthrough would otherwise treat the old
flags as arguments for the selected engine.

## Decision

`jobs new` and `jobs update` use `--name` for the job's schema `alias` and
`--runner` for the prompt action's schema `engine`. The old switches are
rejected as unknown options before engine-argument passthrough, including
`--flag=value` and tokens after `--`. There is no compatibility alias because
the package is pre-1.0 and has no released users (ADR 0027).

The same CLI accepts `--every` as bare seconds or with `s`, `m`, `h`, or `d`
suffixes. It converts these to `schedule.everySec` before invoking the client.
No job schema field or non-CLI surface changes.

## Consequences

Existing scripts using `--alias` or `--engine` must change to `--name` or
`--runner`. A mistyped old switch fails immediately instead of being stored in
`action.args`. Numeric `--every` values retain their seconds meaning.
