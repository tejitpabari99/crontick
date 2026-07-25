# 0004: Loopback-only HTTP as daemon IPC transport

- Status: Accepted
- Date: 2026-07-18

## Context

The CLI, MCP server, and library all need to communicate with the running daemon
process. The daemon owns the SQLite database and the scheduler; clients must ask it to
create jobs, report runs, etc. A transport mechanism is needed that works identically on
Windows, macOS, and Linux without elevated privileges.

## Decision

The daemon exposes a plain HTTP/1.1 REST API bound exclusively to `127.0.0.1:0` (OS-
assigned port). The chosen port is written to `daemon.port` in the data directory.
Clients discover the daemon by reading this file.

Security is enforced at the network layer:

- The HTTP server rejects any connection whose `remoteAddress` is not in the set
  `{'127.0.0.1', '::1', '::ffff:127.0.0.1'}` (see `src/daemon/api.ts` line 21).
- No TLS, no authentication tokens -- the loopback restriction is the sole trust
  boundary, matching the POSIX model where local access implies user-level trust.

## Alternatives considered

**Unix domain sockets / Windows named pipes.** Cross-platform support is uneven in
Node.js (named pipes work differently from UDS). File permission semantics vary across
filesystems. Debugging is harder (cannot `curl` a pipe easily). Would require separate
code paths or an abstraction layer.

**Direct file-based IPC (JSON file locking).** Clients write commands to a queue file;
daemon polls it. Simple but introduces polling latency, complex locking, and no
request-response semantics without building a mini-protocol.

**gRPC or WebSocket.** Adds a heavy dependency (`@grpc/grpc-js` or a WS library) for
what is fundamentally a local request-response API. Protocol buffers or binary frames
add complexity with no benefit over JSON-over-HTTP for the small payloads involved.

**stdio/IPC channel (child_process fork).** Would require the daemon to be a child of
every client process. Incompatible with the single-daemon-many-clients model.

## Consequences

**Easier:**

- Standard `http.createServer` / `fetch` -- no third-party transport libraries.
- Easy to debug with `curl http://127.0.0.1:<port>/api/health`.
- Works identically across all three supported platforms.
- The port file is a single integer -- trivial for any language to discover.

**Harder:**

- Port file can become stale if the daemon crashes without cleanup; `ensureDaemon`
  handles this by probing `process.kill(pid, 0)` and health-checking before trusting
  the port file.
- No built-in encryption -- acceptable for loopback, but means crontick cannot safely
  expose the API to remote clients without additional work.
- OS-assigned port changes on every daemon restart; long-lived clients must re-discover.

**Impossible:**

- Remote access to the daemon without a proxy or tunnel (intentional -- see
  `docs/security.md`).

## Revisit when

- A use case emerges for multi-machine job coordination (would need TLS + auth).
- Node.js stabilizes cross-platform named-pipe support with clean permission semantics,
  reducing the "stale port file" problem.
