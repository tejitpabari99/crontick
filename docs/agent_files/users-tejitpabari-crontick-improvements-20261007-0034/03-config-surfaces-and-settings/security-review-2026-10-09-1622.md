---
status: done
summary: NEEDS_CHANGES - 1 MEDIUM finding (resolved in review-fix commit)
date: 2026-10-09
---
# Security Review - 2026-10-09 16:22 - 03-config-surfaces-and-settings
Diff: origin/main...HEAD (03- commits)

## Verdict: NEEDS_CHANGES

## Findings
### Alert 1
**File:** src/config.ts:492 (writePath), src/config.ts:505 (removePath); reached via src/daemon/api.ts PATCH /api/config, MCP crontick_config_set/unset
**Category:** DataIntegrityFailure
**Severity: MEDIUM | Confidence: 8/10**
**Problem:** Config key paths are validated only by ConfigKeySchema (/^[A-Za-z0-9_.-]+$/), which admits `__proto__`. writePath walks `current[key]` with no own-property check; `isRecord(Object.prototype)` is true, so op `set` key `__proto__.shell` (or `engines.__proto__.env`) writes onto Object.prototype of the running daemon. removePath uses `key in current`, so `unset __proto__.toString` deletes built-ins. Pollution happens before PersistedConfigSchema validation, so the request errors yet the pollution persists until restart. Polluted defaults (`shell`/`env`/`cwd`) can be inherited by spawn option objects and alter how every job executes. Reachable by any caller passing the loopback guard (local processes, prompt-injected MCP agent).
**Evidence:** [verified: node simulation of writePath with {} and ['__proto__','shell'] -> ({}).shell === true; no key denylist in parseKeyPath]
**Suggested fix:** Reject `__proto__`/`constructor`/`prototype` segments in parseKeyPath; own-property checks in writePath/removePath.

## Reviewed, no issue found
Request guard (Host loopback+port, strict JSON content-type, Origin loopback-or-absent, applied centrally by method); redact/restore; lock/atomic write.

## Next step
Back to dev-code to fix Alert 1; add regression tests for __proto__ keys on set and unset.

## Resolution
- Alert 1: fixed - parseKeyPath (the single entry point for client, CLI, MCP and HTTP) rejects the segments with CONFIG_KEY_ERROR; writePath/removePath now use own-property checks. Tests: config-apply-ops.test.ts "key path safety (prototype pollution)" (set + unset, Object.prototype unpolluted), api-config.test.ts "rejects prototype-polluting key paths ..." (HTTP 400 CONFIG_KEY_ERROR), client-config.test.ts "rejects prototype-polluting keys via the client". Docs: errors.md CONFIG_KEY_ERROR, changeset text.
