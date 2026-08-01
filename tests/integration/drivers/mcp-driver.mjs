// mcp-driver.mjs — drives MCP server via stdio JSON-RPC

import { mcpCall } from '../fixtures/mcp-client.mjs';
import { runWithTimeout } from '../utils.mjs';

/** Default MCP timeout in milliseconds. */
const MCP_TIMEOUT_MS = 30_000;

/**
 * Calls a crontick MCP tool and returns the parsed response.
 *
 * @param {string} toolName - MCP tool name (e.g. 'crontick_daemon_status')
 * @param {object} toolArgs - Tool arguments object
 * @param {{ bins: { mcp: string }; scratchDir: string; testHome: string; env?: Record<string, string> }} ctx
 * @returns {Promise<object>} Parsed JSON-RPC response (id:2)
 */
export async function runMcp(toolName, toolArgs, ctx) {
  // TODO(A3): implement
  void mcpCall;
  void runWithTimeout;
  void toolName;
  void toolArgs;
  void ctx;
  void MCP_TIMEOUT_MS;
  throw new Error('runMcp: not implemented');
}
