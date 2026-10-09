---
status: done
summary: BLOCK - 1 HIGH, 1 MEDIUM (both fixed in review-fix commit)
date: 2026-10-09
---
# Security Review - 2026-10-09 17:19 - 06-webhook-trigger
Diff: origin/main...HEAD (06- commits)

## Verdict: BLOCK

## Findings
### Alert 1
**File:** src/daemon/api.ts:293-299 (GET /api/jobs/:id via redactKeepingWebhook, api.ts:57-58); also GET /api/export?includeSecrets=1 (~api.ts:687); guard scope src/daemon/request-guard.ts:13-15
**Category:** BrokenAccessControl (DNS-rebinding/CSRF-class)
**Severity: HIGH | Confidence: 7/10**
**Problem:** The full relay URL (bearer secret: anyone with it can POST events that start runs) and the raw HMAC secret are returned on an unauthenticated GET. The request guard (Host/Origin/Content-Type) covers only mutating methods; the only GET gate is socket remoteAddress == loopback. A DNS-rebinding page (Host: attacker.com resolving to 127.0.0.1 -> daemon port) is same-origin to itself, so it can GET /api/jobs, then GET /api/jobs/:id and read relay + secret, then POST to the smee channel (signing with the secret) to trigger the job remotely -> arbitrary prompt/command runs with attacker payload.
**Evidence:** [verified: api.ts:159 guard only if isGuardedRequest(mutating); api.ts:298 sendJson(redactKeepingWebhook(job)) returns job.schedule raw; no Host check on GET]
**Suggested fix:** Apply the loopback Host check to GET /api/* (at least secret-bearing routes), or never return raw relay/secret over HTTP.

### Alert 2
**File:** src/daemon/relay-guard.ts:50-66,87-96 ; src/daemon/relay.ts:221-232
**Category:** AuthenticationFailure (HMAC replay / unsigned-field injection)
**Severity: MEDIUM | Confidence: 8/10**
**Problem:** HMAC covers only JSON.stringify(data.body). Dedupe key is the unsigned x-github-delivery / x-request-id header (body hash only when absent). Anyone holding the relay URL can subscribe to the SSE stream, capture a signed event, and re-POST the same body+signature with a new id: the signature verifies, the dedupe key is fresh, the job runs again (only the 10/min bucket limits it). The unsigned `query` and allowlisted headers (x-github-event, x-event-key, content-type, user-agent) also reach CRONTICK_EVENT/prompt on a "verified" event, so an attacker can flip x-github-event or add query data on a signed body. This defeats the purpose of --webhook-secret.
**Evidence:** [verified: verifySignature(secret, d.data['body'], sig) only; deliveryKey uses headerValue before body hash; buildWebhookPayload takes obj.query and header allowlist unsigned]
**Suggested fix:** Dedupe on the signature value (or body hash) when a secret is set; drop `query` and unsigned headers (or mark them unverified) for signed jobs.

## Checked, no issue
- Timing-safe compare with length check: OK. Secret unset => no check (documented; URL is bearer).
- HMAC over re-serialized parsed body causes false rejects for GitHub-style payloads, fail-closed; not a vuln.
- Payload to commands via env only (CRONTICK_EVENT); no shell interpolation. Prompt: preamble + adaptive fence + 64KB cap.
- SSRF: relay URL set by job owner (https or loopback http); `--relay auto` uses no redirect-follow, validated target.
- Log/API/MCP/export redaction present; no new dependencies.

## Next step
BLOCK -> do not land. Back to `dev-code` for an immediate fix; re-run `dev-security-review` on the follow-up diff.

## Resolution
- Alert 1 (HIGH): fixed - Host/Origin guard now covers every `/api` request including GET and `/api/export`; `/health` unguarded. Tests: `tests/unit/request-guard.test.ts` (GET non-loopback Host/Origin -> 403 REQUEST_REJECTED; loopback -> 200). Docs/changeset/spec 004 updated (BREAKING HTTP API note widened).
- Alert 2 (MEDIUM): fixed - with a secret, dedupe key is `sig:<signature>`; signed jobs get only the HMAC-covered `body` (no headers/query), documented. Tests: `relay-guard.test.ts` (replay with fresh id deduped), `relay.test.ts` (bodyOnly payload).
- Follow-up (Alert 2): signed jobs get headers/query again (GitHub event type lives only in headers); payload marked `verified: true, verifiedScope: 'body'`; replay still blocked by signature-keyed dedupe; documented as unauthenticated.
