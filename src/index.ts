// @general-liquidity/mcp — an MCP server exposing a CURATED, coarse-grained projection of
// the General Liquidity surface as tools (money/identity · memory · read-back), NOT a 1:1
// dump of every operation. Each tool delegates to an INJECTED `GeneralLiquidity` client
// (the sdk shape from @general-liquidity/sdk); the settle primitive lives behind that
// client, never here, and the operator verbs (approve · refund · kill switch · forget) are
// absent by construction — see the header in ./tools.ts.
//
// Tool failures are structured: every handler returns the shared RFC 9457 problem the REST
// surface emits, so an agent branches on a stable code and action class rather than on a
// thrown string. See ./problem.ts (taxonomy) and ./results.ts (mapping).

import type { GeneralLiquidity } from "@general-liquidity/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildTools } from "./tools.ts";

export type {
  ErrorAction,
  PendingApproval,
  Problem,
  ProblemCode,
} from "./problem.ts";
export {
  ALL_ERROR_ACTIONS,
  ALL_PROBLEM_CODES,
  actionFor,
  isRetryable,
  nextStep,
  problem,
  requiresHuman,
} from "./problem.ts";
export type { AnyToolDef, StructuredError, ToolDef, ToolResult } from "./tools.ts";
export {
  ALL_TOOL_NAMES,
  buildTools,
  MEMORY_TOOL_NAMES,
  READ_TOOL_NAMES,
  TOOL_NAMES,
} from "./tools.ts";

export interface McpServerOptions {
  name?: string;
  version?: string;
}

/**
 * Build an MCP server projecting the curated GL surface. The `client` is injected
 * (dependency inversion) and typed only by `@general-liquidity/sdk` — this package imports
 * no server implementation. Returns an unconnected `McpServer`; the caller wires a
 * transport (stdio / HTTP) at the composition root.
 */
export function createMcpServer(
  client: GeneralLiquidity,
  options: McpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: options.name ?? "@general-liquidity/mcp",
    version: options.version ?? "0.0.0",
  });

  for (const tool of buildTools(client)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      tool.handler as never,
    );
  }

  return server;
}
