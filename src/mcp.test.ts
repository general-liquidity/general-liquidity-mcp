import { describe, expect, test } from "bun:test";
import type {
  Counterparty,
  Decision,
  Disclosure,
  GeneralLiquidity,
  Intent,
  Receipt,
} from "@general-liquidity/sdk";
import { buildTools, createMcpServer, TOOL_NAMES } from "./index.ts";

interface Calls {
  resolve: string[];
  pay: Intent[];
  verify: Disclosure[];
  disclose: number;
}

function fakeClient(): { client: GeneralLiquidity; calls: Calls } {
  const calls: Calls = { resolve: [], pay: [], verify: [], disclose: 0 };
  const client: GeneralLiquidity = {
    async resolve(ref) {
      calls.resolve.push(ref);
      return { id: ref, transport: "caip", capabilities: [], rails: ["x402"] } as Counterparty;
    },
    async pay(intent) {
      calls.pay.push(intent);
      return {
        intentKey: intent.idempotencyKey,
        rail: intent.terms.rail,
        reference: "0xabc",
        terms: intent.terms,
        settledAt: "2026-01-01T00:00:00Z",
        enforcement: "hash",
      } as Receipt;
    },
    async verify(disclosure) {
      calls.verify.push(disclosure);
      return { outcome: "allow", reasons: [], mandateId: "m1" } as Decision;
    },
    async disclose() {
      calls.disclose += 1;
      return {
        document: {},
        signature: { algorithm: "ed25519", publicKey: "gl", value: "sig" },
      } as Disclosure;
    },
    // Agent read surface: not exercised by the MCP tool tests, stubbed to satisfy the
    // GeneralLiquidity contract.
    async getJob(id) {
      return {
        id,
        status: "settled",
        createdAt: "2026-01-01T00:00:00Z",
        outcome: "allow",
        links: { self: `/intents/${id}`, events: `/intents/${id}/events` },
      };
    },
    async getJobEvents() {
      return { data: [], hasMore: false, nextCursor: null };
    },
    async getAudit() {
      return { data: [], hasMore: false, nextCursor: null };
    },
    async getUsage(query) {
      return {
        keyId: "key-1",
        since: query.since,
        until: query.until,
        total: 0,
        byOperation: {},
        byOutcome: {},
      };
    },
    // The memory half of the client. This server projects none of it as a tool,
    // but the fake has to satisfy the interface or the type drifts silently.
    async memoryRemember() {
      throw new Error("not used by the MCP surface");
    },
    async memoryRecall() {
      throw new Error("not used by the MCP surface");
    },
    async memoryAssemble() {
      throw new Error("not used by the MCP surface");
    },
    async memoryVerify() {
      throw new Error("not used by the MCP surface");
    },
  };
  return { client, calls };
}

const wireIntent = {
  idempotency_key: "idem-1",
  payee: "did:example:merchant",
  amount: { value: "1000", asset: "USDC" },
  purpose: "api-credits",
  terms: {
    reversibility: "irreversible" as const,
    finality: "instant" as const,
    credential: "eip3009",
    rail: "x402" as const,
    capital_source: "payer" as const,
    presence: "delegated" as const,
  },
  envelope: {
    identity: "did:example:agent",
    mandate_id: "m1",
    grant: {
      agent_id: "did:example:agent",
      mandate_id: "m1",
      expires_at: "2026-12-31T00:00:00Z",
      signature: "gsig",
    },
    signature: "esig",
  },
};

describe("curated tool surface", () => {
  test("registers exactly the four curated verbs", () => {
    const { client } = fakeClient();
    const names = buildTools(client).map((t) => t.name);
    expect(names).toEqual([...TOOL_NAMES]);
    expect(names).not.toContain("settle");
    expect(names).not.toContain("grant");
  });

  test("resolve delegates the ref to the injected client", async () => {
    const { client, calls } = fakeClient();
    const resolve = buildTools(client).find((t) => t.name === "resolve")!;
    const res = await resolve.handler({ ref: "caip:eip155:1:0x1" } as never);
    expect(calls.resolve).toEqual(["caip:eip155:1:0x1"]);
    expect(res.content[0]!.text).toContain("caip:eip155:1:0x1");
  });

  test("pay maps the snake_case tool input to a canonical Intent and delegates", async () => {
    const { client, calls } = fakeClient();
    const pay = buildTools(client).find((t) => t.name === "pay")!;
    await pay.handler({ intent: wireIntent } as never);
    expect(calls.pay).toHaveLength(1);
    const intent = calls.pay[0]!;
    expect(intent.idempotencyKey).toBe("idem-1");
    expect(intent.terms.capitalSource).toBe("payer");
    expect(intent.envelope.mandateId).toBe("m1");
    expect(intent.envelope.grant.agentId).toBe("did:example:agent");
  });

  test("verify maps disclosure and delegates", async () => {
    const { client, calls } = fakeClient();
    const verify = buildTools(client).find((t) => t.name === "verify")!;
    const res = await verify.handler({
      disclosure: {
        document: { role: "merchant" },
        signature: { algorithm: "ed25519", public_key: "cp", value: "s" },
      },
    } as never);
    expect(calls.verify).toHaveLength(1);
    expect(calls.verify[0]!.signature.publicKey).toBe("cp");
    expect(res.structuredContent).toBeDefined();
  });

  test("disclose delegates with no args", async () => {
    const { client, calls } = fakeClient();
    const disclose = buildTools(client).find((t) => t.name === "disclose")!;
    await disclose.handler({} as never);
    expect(calls.disclose).toBe(1);
  });

  test("createMcpServer wires the tools onto a real McpServer", () => {
    const { client } = fakeClient();
    const server = createMcpServer(client, { name: "test", version: "1.2.3" });
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe("function");
  });
});
