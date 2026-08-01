'use strict';
// fixtures/mock-engine.cjs — stub mock prompt engine (CJS: prompt protocol)
// TODO(A5): implement the mock engine protocol handler

// When spawned by crontick as a prompt engine, this process communicates over
// stdio. Full implementation is deferred to a later task.
// For now, exit immediately so the harness scaffold can be committed.
process.exit(0);
