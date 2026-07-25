# 0006: Use croner as the cron expression engine

- Status: Accepted
- Date: 2026-07-18

## Context

crontick needs to parse cron expressions, compute next-fire times, and support timezone-
aware scheduling. The scheduler (`src/daemon/scheduler.ts`) must handle standard 5-field
cron, optional seconds field, and timezone offsets reliably.

## Decision

Use `croner` v9 as the sole cron parsing and scheduling library. It provides:

- `new Cron(expression, options)` for scheduling with timezone support.
- `Cron.nextRuns(n)` for preview (used by `schedule preview` and the MCP tool).
- Validation via constructor error on invalid expressions.
- Support for the extended 6-field (seconds) syntax.
- No native dependencies -- pure JavaScript/TypeScript.

The scheduler wraps croner timers for `cron`-kind schedules and uses native
`setTimeout`/`setInterval` for `interval` and `one-shot` kinds.

## Alternatives considered

**`cron-parser`** (npm). Parses expressions and computes next dates, but does not
provide a scheduling timer -- you still need to build the fire loop yourself. Lower-
level than needed.

**`node-cron`** (npm). Popular but lacks timezone support in the scheduler, has a
larger dependency tree, and does not support the seconds field without a fork.

**`later.js`** (npm). Unmaintained since 2015. No TypeScript types, no timezone support.

**Custom parser.** Avoids dependencies but is error-prone for edge cases (DST
transitions, leap seconds, non-standard extensions). crontick's value is in
orchestration, not cron parsing.

**`Temporal` API (TC39 proposal).** Not yet stable in Node.js; would still require a
separate cron expression parser.

## Consequences

**Easier:**

- One dependency handles parsing, validation, next-run computation, and timer
  scheduling.
- Timezone handling delegates to croner's tested implementation instead of manual offset
  math.
- Preview endpoint (`schedule preview`) is a trivial `Cron.nextRuns(n)` call.
- Lightweight: croner has zero transitive dependencies.

**Harder:**

- Coupled to croner's interpretation of edge cases (e.g., DST spring-forward behavior).
  If croner's behavior diverges from user expectations, crontick inherits the bug.
- Upgrading croner major versions may change scheduling semantics.

**Impossible:**

- Using a non-standard cron dialect that croner does not support without forking.

## Revisit when

- croner is abandoned or a critical scheduling bug is discovered with no upstream fix.
- A requirement emerges for calendar-based scheduling (e.g., "first business day of the
  month") that croner cannot express.
- The TC39 Temporal API stabilizes and Node.js provides built-in cron-like scheduling
  primitives.
