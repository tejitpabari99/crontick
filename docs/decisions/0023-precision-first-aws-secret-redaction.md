# 0023: Prefer precision over recall for AWS secret redaction

- Status: Accepted
- Date: 2026-07-31

## Context

CTD-018 and CTD-019 moved crontick's secret masking to one shared redaction contract in
`src/logger.ts`, then tightened key-hint matching so benign names such as `NON_SECRET`
stayed visible. CTD-022 exposed a narrower but still serious integrity bug inside that
shared contract: the standalone AWS secret-access-key fallback treated any unlabeled
40-character base64-ish token as an AWS secret if it matched a stricter character-shape
profile. QA reproduced this with the benign runtime payload
`aGVsbG8gd29ybGQgZnJvbSBjcm9udGljayBxYQ==`, which was redacted on `logs tail`, dashboard
data, and `/api/export` because those surfaces all read through the same persisted-log and
read-time redaction funnels.

That behavior was a real product bug, not a cosmetic preference. Silently replacing a
benign value with `[REDACTED]` corrupts user-visible logs and exported data. A bare AWS
secret access key is fundamentally indistinguishable from other 40-character base64-ish
blobs when no surrounding context exists, so any standalone heuristic inevitably trades
false negatives for false positives. CTD-022 showed that the false-positive side of that
tradeoff is unacceptable for crontick.

## Decision

crontick removes the bare/standalone AWS secret-access-key heuristic entirely. The shared
redaction contract now redacts AWS secret access keys only when one of these higher-
confidence signals exists:

1. **Key-hint context** such as `AWS_SECRET_ACCESS_KEY=...`, `aws_secret_access_key=...`,
   `AWS Secret Access Key: ...`, or JSON/object fields such as `secretAccessKey`.
2. **Credential-pair context** where a 40-character AWS-secret-shaped token appears near an
   AWS access key id (`AKIA...` or `ASIA...`) in the same logical line/context.

Unlabeled standalone 40-character base64-ish tokens are preserved exactly, even if a few
real bare AWS secret access keys therefore remain visible. This supersedes only the
standalone-AWS-fallback sub-decision from ADR 0022; ADR 0022 remains the governing shared
redaction-contract decision for every other secret family and surface.

## Alternatives considered

**Keep the standalone fallback with a stricter regex.** Rejected. CTD-022 demonstrated
that regex tightening does not solve the root problem: an isolated 40-character base64-ish
blob has no reliable distinguishing marker.

**Redact every bare 40-character base64-ish token.** Rejected. This maximizes recall at
the cost of routinely corrupting benign output, exports, and dashboards.

**Allow per-surface exceptions for the benign sample.** Rejected. The bug lives in the
shared choke point, and surface-local carveouts would immediately drift from the contract
set by CTD-018 and ADR 0022.

## Consequences

**Easier / safer:**

- Benign runtime payloads and exports keep their original bytes.
- `logs tail`, dashboard data, `/api/export`, config reads, and other read surfaces stay in
  sync because they still use one shared contract.
- Contextual AWS secrets, AWS access key ids, JWTs, prefixed tokens, key/value secret
  assignments, and private keys (including streamed PEM blocks split across chunks) remain
  protected.

**Harder / accepted tradeoff:**

- A truly bare AWS secret access key with zero surrounding context may no longer redact.
  This is intentional. crontick chooses precision over recall for this one ambiguous shape
  because corrupting benign user data is itself a data-integrity bug.

## Revisit when

Revisit this decision only if crontick gains a new high-confidence AWS-specific context
signal that can distinguish bare secrets from unrelated base64 data without reintroducing
CTD-022-style false positives.
