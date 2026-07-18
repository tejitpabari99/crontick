# Schedules

crontick supports three schedule kinds through the CLI, daemon API, and MCP server.

## `cron`

```json
{ "kind": "cron", "cron": "0 9 * * 1-5", "tz": "America/Los_Angeles" }
```

Notes:

- Standard 5-field cron expressions are expected for user-facing configuration.
- Croner parsing is used under the hood, so aliases and some extended forms are accepted.
- Use `crontick_schedule_validate` or `POST /api/schedules/validate` before creating jobs.
- Use preview to confirm the next fire times.

### Supported aliases

- `@yearly`, `@annually`
- `@monthly`
- `@weekly`
- `@daily`, `@midnight`
- `@noon`
- `@hourly`
- `@every_minute`

## `interval`

```json
{ "kind": "interval", "everySec": 300 }
```

Optional `startAt` aligns the first fire to a specific ISO-8601 timestamp.

## `one-shot`

```json
{ "kind": "one-shot", "runAt": "2026-07-18T20:00:00Z" }
```

One-shot jobs fire once in the future and then remove their timer entry.

## Time zones

Only cron schedules use `tz`. Interval and one-shot schedules use their numeric delay or absolute timestamp directly.

## Catchup policy

`catchup` controls what happens when the daemon was offline:

- `skip` — do nothing for missed fires
- `run-once` — emit a single catchup tick
- `run-all` — emit all missed ticks (bounded internally)

## Preview examples

```sh
curl -X POST http://127.0.0.1:<port>/api/schedules/preview \
  -H "content-type: application/json" \
  -d '{"schedule":{"kind":"cron","cron":"0 9 * * 1-5"},"n":5}'
```
