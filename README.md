# `@general-liquidity/mcp`

A curated MCP server that projects the General Liquidity surface as twelve
task-shaped tools in three groups: money/identity, memory, and read-back. It is
deliberately **not** a 1:1 dump of every REST endpoint, which would overrun an
agent's token budget. The tool names *are* the surface verbs, and there is no
`settle` or `grant` tool: settlement stays behind the client, and mandate
granting is operator-only.

The server wraps a `GeneralLiquidity` client from
[`@general-liquidity/sdk`](https://github.com/general-liquidity/general-liquidity-typescript).
The client is **injected** (dependency inversion): this package holds no settle
primitive and no server implementation of its own. It signs and submits intents
through the injected client; the sovereign gate decides and settles.

## The tools

Money and identity:

- `resolve` — normalize any counterparty reference (A2A card, signed disclosure,
  CAIP) into one identity with its accepted rails and trust signals.
- `pay` — submit a signed Intent to move value. The gate decides; on allow it
  settles on the right rail and returns a Receipt.
- `verify` — check a counterparty's signed disclosure against policy and return a
  Decision.
- `disclose` — produce this agent's own signed disclosure: what it is and what it
  is authorized to do.

Commerce (the opt-in tier):

- `quote` — price a cart against a merchant over a checkout protocol (`acp` or
  `ucp`). Commits nothing and moves no money; returns the server-authoritative
  Cart the merchant priced. Only a Cart in status `ready` can then be bought.
- `buy` — drive that checkout to a completed Order, authorized through the same
  gate `pay` uses. The merchant stays merchant-of-record.

The price is never the caller's to set: it comes from the cart the merchant
priced, which is why `buy` takes lines and no amount. Its replay key rides the
body and must be supplied, because only a caller that chose its own key can
safely re-send after a retryable rail failure. There is no parked-intent path —
a merchant session cannot be held open across an out-of-band operator approval,
so a gate `confirm` comes back as `intent.denied`, not `approval.pending`.

Both tools are registered on every server even though the tier is opt-in per
deployment: a tool list whose shape depends on the stack is one a model cannot
plan against. A deployment without the tier answers `not_found`, which arrives
as the same structured problem as any other refusal.

Memory (bi-temporal, mandate-scoped):

- `memory_remember` — write one bi-temporal record under a mandate.
- `memory_recall` — read a sealed point-in-time snapshot, cursor-paginated.
- `memory_assemble` — assemble a budgeted, signed context.
- `memory_verify` — verify a signed memory artifact offline.

Read-back over the calling principal's own record:

- `get_job` — the lifecycle of one intent by its idempotency key.
- `get_job_events` — that intent's signed, hash-linked audit events.
- `get_audit` — the audit trail across every intent.
- `get_mandate` — the live spend authority covering the caller: caps, expiry, when the
  period resets, and how much of each has been drawn.
- `get_usage` — metered call counts over a window.

`get_mandate` is the one an agent should reach for BEFORE committing to anything
metered or long-running, rather than discovering a ceiling by being refused. Its
description carries a warning worth repeating here: `spent` and `remaining` are
ABSENT together when the server holds a prior spend in a currency it cannot
convert, which is the same state in which the gate refuses to authorize at all.
Absent means unknown, never zero — the opposite reading has a model believe it
holds its whole budget at exactly the moment it holds none.

### What is deliberately absent

There is no `approve`, `refund`, kill switch, `memory_forget` or webhook CRUD
tool. Those routes live in a disjoint authorization domain — the detached
`GL-Operator` ed25519 credential — which the injected agent client cannot mint.
Exposing them would either be dead weight or, worse, would let an agent release
its own parked spend. An agent that can approve its own payment has no gate.

## Structured failures

Every tool failure comes back as the same RFC 9457 problem the REST surface
emits, on `structuredContent`, never as a thrown string:

```json
{
  "code": "intent.denied",
  "message": "The gate denied intent idem-1.",
  "action": "escalate-to-human",
  "data": {
    "type": "https://docs.generalliquidity.com/problems/intent.denied",
    "status": 403,
    "action": "escalate-to-human",
    "nextStep": "Stop. A human operator must decide; no retry helps.",
    "retryable": false,
    "reasons": ["payee not on the mandate"]
  }
}
```

Branch on `action`, not on `code`: codes are added over time, while the four
action classes (`never-retry`, `retry-as-is`, `retry-after-renegotiation`,
`escalate-to-human`) are closed. A `confirm` verdict is one of these problems
(`approval.pending`) and carries the parked intent id and challenge an operator
needs to release it out-of-band.

The taxonomy in `src/problem.ts` mirrors the platform's
`@general-liquidity/surface` vocabulary, which is an unpublished workspace
package this repository cannot import. `src/results.ts` also bridges the SDK's
own legacy error slugs (`denied`, `rate-limited`, `validation`) onto it, so an
older peer still speaks the shared codes.

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
- `TOOL_NAMES` / `COMMERCE_TOOL_NAMES` / `MEMORY_TOOL_NAMES` / `READ_TOOL_NAMES` /
  `ALL_TOOL_NAMES` — the exposed tool names, by group.
- `problem` / `actionFor` / `nextStep` / `isRetryable` / `requiresHuman` /
  `ALL_PROBLEM_CODES` and the `Problem`, `ProblemCode`, `ErrorAction`,
  `StructuredError` types — the shared failure taxonomy.

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
