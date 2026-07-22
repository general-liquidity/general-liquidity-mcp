# `@general-liquidity/mcp`

A curated MCP server that projects the General Liquidity surface as four
task-shaped tools: `resolve`, `pay`, `verify`, and `disclose`. It is deliberately
**not** a 1:1 dump of every REST endpoint, which would overrun an agent's token
budget. The tool names *are* the surface verbs, and there is no `settle` or
`grant` tool: settlement stays behind the client, and mandate granting is
operator-only.

The server wraps a `GeneralLiquidity` client from
[`@general-liquidity/sdk`](https://github.com/general-liquidity/general-liquidity-typescript).
The client is **injected** (dependency inversion): this package holds no settle
primitive and no server implementation of its own. It signs and submits intents
through the injected client; the sovereign gate decides and settles.

## The four tools

- `resolve` — normalize any counterparty reference (A2A card, signed disclosure,
  CAIP) into one identity with its accepted rails and trust signals.
- `pay` — submit a signed Intent to move value. The gate decides; on allow it
  settles on the right rail and returns a Receipt.
- `verify` — check a counterparty's signed disclosure against policy and return a
  Decision.
- `disclose` — produce this agent's own signed disclosure: what it is and what it
  is authorized to do.

## Adding it to an agent host

`createMcpServer` returns an unconnected `McpServer`. You wire the client and a
transport (stdio / HTTP) at your composition root:

```ts
import { createMcpServer } from "@general-liquidity/mcp";
import { createClient } from "@general-liquidity/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const client = createClient({ baseUrl, signer }); // any GeneralLiquidity impl
const server = createMcpServer(client, { name: "gl", version: "1.0.0" });

await server.connect(new StdioServerTransport());
```

Point your agent host (Claude Desktop, an IDE MCP client, or any stdio MCP host)
at the process running that entry point.

## What it exports

- `createMcpServer` / `McpServerOptions` — build the curated MCP server over an
  injected client.
- `buildTools` / `ToolDef` / `ToolResult` — the tool set and its call-result shape,
  exported separately so tests can assert registration and delegation with a fake
  client and no transport.
- `TOOL_NAMES` — the four exposed tool names.

## Dependencies

- `@general-liquidity/sdk` — supplies the `GeneralLiquidity` client type and the
  wire nouns (`Intent`, `Disclosure`, `Counterparty`, `Receipt`, `Decision`).
- `@modelcontextprotocol/sdk` — the MCP `McpServer`.
- `zod` — tool input schemas.

## Development

```
bun install
bunx tsc --noEmit -p tsconfig.json
bun test
bunx biome check .
```
