# 0022: Keep secret redaction as one shared streaming contract

- Status: Accepted
- Date: 2026-07-30

## Context

Round-2 QA surfaced four closely-related problems in crontick's secret handling. First,
persisted run logs still leaked private keys when `BEGIN ... PRIVATE KEY`, body lines,
and `END ... PRIVATE KEY` arrived in separate stdout/stderr chunks. Second, structured
config/read surfaces over-redacted benign values because key-name matching treated broad
substrings such as `NON_SECRET` as authoritative evidence that a value was sensitive.
Third, AWS secret-access-key material leaked in some contexts unless it was already labeled
with an obvious key name. Finally, the affected output was visible on multiple surfaces
(run reads, log tails, dashboard data, config reads, exports, and daemon logs), so
fixing one surface at a time would either miss a path or let behavior drift again later.

crontick already had one intended choke point for redaction in `src/logger.ts`, but the
observed defects showed that a purely stateless text pass plus broad key-name matching was
not precise enough. The fix therefore needed to define a durable contract, not just patch
a few regular expressions.

## Decision

Secret redaction stays centralized in `src/logger.ts` and is treated as one shared
contract for every write/read surface that emits user-visible text. The contract has four
parts:

1. **One choke point, not per-surface shims.** CLI, MCP, dashboard, config, daemon API,
   and daemon logging do not add their own secret-specific masking rules. They call the
   shared logger redaction helpers (directly or through shared core flows) so the same
   rules apply everywhere.
2. **Streaming private-key protection at the write-time choke point.** Persisted run-log
   capture uses a streaming redactor that can recognize a private-key block even when the
   begin marker, body, and end marker are split across multiple chunks or lines. Stateless
   read-time redaction still exists as defense in depth, but new log bytes must already be
   safe before they reach storage.
3. **Precise structured-secret classification.** Key-hint redaction uses normalized,
   high-confidence suffix matching (`api_key`, `client_secret`, `access_token`,
   `secret_access_key`, `private_key`, etc.) and explicitly rejects negated/broad
   substring traps such as `NON_SECRET`, `NOT_TOKEN`, `secretary`, and `monkey`.
4. **Two-tier AWS secret detection.** The contract redacts AWS secret-access-key material
   either when strong surrounding context says a 40-character token is an AWS secret, or
   when the token matches the stricter standalone 40-character fallback profile used for
   canonical unlabeled AWS secrets.

Read surfaces continue to re-apply the same contract before serializing config values, run
rows, log text, dashboard data, and exports so that older already-persisted values stay
protected.

## Alternatives considered

**Patch each surface independently.** Rejected: it duplicates logic, guarantees future
drift, and would still miss stored-log bytes for new runs unless the runner also changed.

**Use only stateless regexes.** Rejected: a full private-key block regex cannot match when
`BEGIN`, body, and `END` arrive in different capture chunks, which was the real leak.

**Keep broad substring key matching and add special-case exclusions.** Rejected: it does
not scale and would keep the redaction boundary hard to reason about for both users and
maintainers.

**Redact every 40-character base64-ish token as an AWS secret.** Rejected: it would
over-redact hashes, random identifiers, and other benign values, recreating the trust
problem that the `NON_SECRET` false positive demonstrated from a different angle.

## Consequences

**Easier:**

- Every read surface inherits the same behavior automatically.
- New persisted run-log bytes no longer depend on whole-block PEM matching.
- Users can rely on benign values such as `NON_SECRET` staying visible.
- The AWS-secret rule is explicit enough to test as a must-redact/must-not-redact corpus.

**Harder:**

- The runner now owns a small amount of streaming redaction state instead of treating each
  chunk independently.
- Adding a new secret family requires updating the shared contract carefully so it does not
  widen false positives on every surface at once.

**Impossible:**

- Surface-local compatibility shims that intentionally diverge from the shared contract.
  If a redaction rule changes, it changes through the core contract for every surface.

## Revisit when

Revisit this decision if crontick adds a fundamentally new output channel that cannot call
through the shared logger contract, or if field evidence shows the standalone AWS fallback
needs a different high-confidence profile.