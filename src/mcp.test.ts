import { describe, expect, test } from "bun:test";
import type {
  AssembleRequest,
  BuyRequest,
  Cart,
  Commerce,
  Counterparty,
  Decision,
  Disclosure,
  GeneralLiquidity,
  Intent,
  Order,
  PageQuery,
  QuoteRequest,
  RecallRequest,
  Receipt,
  RememberRequest,
  UsageQuery,
} from "@general-liquidity/sdk";
import {
  ALL_TOOL_NAMES,
  buildTools,
  COMMERCE_TOOL_NAMES,
  createMcpServer,
  MEMORY_TOOL_NAMES,
  READ_TOOL_NAMES,
  TOOL_NAMES,
} from "./index.ts";

interface Calls {
  resolve: string[];
  pay: Intent[];
  verify: Disclosure[];
  disclose: number;
  memoryRemember: RememberRequest[];
  memoryRecall: Array<{ req: RecallRequest; page: PageQuery }>;
  quote: QuoteRequest[];
  buy: BuyRequest[];
  memoryAssemble: AssembleRequest[];
  memoryVerify: unknown[];
  getJob: string[];
  getJobEvents: Array<{ id: string; query: PageQuery }>;
  getAudit: PageQuery[];
  getUsage: UsageQuery[];
  getMandate: number;
}

const ALLOW: Decision = { outcome: "allow", reasons: [], mandateId: "m1" };

function fakeClient(decision: Decision = ALLOW): {
  client: GeneralLiquidity & Commerce;
  calls: Calls;
} {
  const calls: Calls = {
    resolve: [],
    pay: [],
    verify: [],
    disclose: 0,
    quote: [],
    buy: [],
    memoryRemember: [],
    memoryRecall: [],
    memoryAssemble: [],
    memoryVerify: [],
    getJob: [],
    getJobEvents: [],
    getAudit: [],
    getUsage: [],
    getMandate: 0,
  };
  const client: GeneralLiquidity & Commerce = {
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
    async quote(req) {
      calls.quote.push(req);
      return {
        id: "cart-1",
        protocol: req.rail,
        status: "ready",
        currency: req.currency,
        total: { value: "1200", asset: req.currency },
        merchant: req.merchant,
      } as Cart;
    },
    async buy(req) {
      calls.buy.push(req);
      return {
        id: "order-1",
        cartId: "cart-1",
        protocol: req.rail,
        status: "completed",
        merchant: req.merchant,
        receipt: {
          intentKey: "cart-1",
          rail: req.terms.rail,
          reference: "0xdef",
          terms: req.terms,
          settledAt: "2026-01-01T00:00:00Z",
          enforcement: "hash",
        } as Receipt,
        placedAt: "2026-01-01T00:00:00Z",
      } as Order;
    },
    async verify(disclosure) {
      calls.verify.push(disclosure);
      return decision;
    },
    async disclose() {
      calls.disclose += 1;
      return {
        document: {},
        signature: { algorithm: "ed25519", publicKey: "gl", value: "sig" },
      } as Disclosure;
    },
    async getJob(id) {
      calls.getJob.push(id);
      return {
        id,
        status: "settled",
        createdAt: "2026-01-01T00:00:00Z",
        outcome: "allow",
        links: { self: `/intents/${id}`, events: `/intents/${id}/events` },
      };
    },
    async getJobEvents(id, query = {}) {
      calls.getJobEvents.push({ id, query });
      return { data: [], hasMore: false, nextCursor: null };
    },
    async getAudit(query = {}) {
      calls.getAudit.push(query);
      return { data: [], hasMore: false, nextCursor: null };
    },
    async getMandate() {
      calls.getMandate += 1;
      return [];
    },
    async getUsage(query) {
      calls.getUsage.push(query);
      return {
        keyId: "key-1",
        since: query.since,
        until: query.until,
        total: 0,
        byOperation: {},
        byOutcome: {},
      };
    },
    async memoryRemember(req) {
      calls.memoryRemember.push(req);
      return {
        id: "rec-1",
        body: req.body,
        validFrom: req.validFrom,
        validTo: req.validTo,
        recordedAt: "2026-01-01T00:00:00Z",
        invalidatedAt: null,
        edges: req.edges ?? [],
        taint: false,
        source: req.source,
      };
    },
    async memoryRecall(req, page = {}) {
      calls.memoryRecall.push({ req, page });
      return {
        data: [],
        hasMore: false,
        nextCursor: null,
        validAt: req.validAt,
        txAt: req.txAt,
        seal: { hash: "h", signature: "s" },
      };
    },
    async memoryAssemble(req) {
      calls.memoryAssemble.push(req);
      return {
        records: [],
        order: [],
        budget: req.budget,
        abstained: false,
        seal: { hash: "h", signature: "s" },
      };
    },
    async memoryVerify(artifact) {
      calls.memoryVerify.push(artifact);
      return { valid: true };
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
  test("registers exactly the curated groups, in order", () => {
    const { client } = fakeClient();
    const names = buildTools(client).map((t) => t.name);
    expect(names).toEqual([...ALL_TOOL_NAMES]);
    expect(ALL_TOOL_NAMES).toEqual([
      ...TOOL_NAMES,
      ...COMMERCE_TOOL_NAMES,
      ...MEMORY_TOOL_NAMES,
      ...READ_TOOL_NAMES,
    ] as never);
    expect(names).not.toContain("settle");
    expect(names).not.toContain("grant");
  });

  test("no operator verb is reachable from the agent surface", () => {
    const { client } = fakeClient();
    const names = buildTools(client).map((t) => t.name);
    // Approve / refund / kill switch / erasure live in the disjoint `GL-Operator`
    // credential domain the injected agent client cannot mint. An agent that could
    // approve its own parked payment would make the gate decorative.
    for (const operatorVerb of [
      "approve",
      "refund",
      "kill_switch",
      "memory_forget",
      "forget",
      "webhook_create",
    ]) {
      expect(names).not.toContain(operatorVerb);
    }
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

  test("quote delegates the priced-cart request without an envelope", async () => {
    const { client, calls } = fakeClient();
    const quote = buildTools(client).find((t) => t.name === "quote")!;
    const res = await quote.handler({
      rail: "acp",
      merchant: "shop.example",
      currency: "USD",
      lines: [{ id: "sku-1", quantity: 2 }],
    } as never);
    expect(calls.quote).toHaveLength(1);
    expect(calls.quote[0]!.lines).toEqual([{ id: "sku-1", quantity: 2 }]);
    // Commits nothing, so it carries no mandate-bearing envelope and no terms.
    expect(calls.quote[0]).not.toHaveProperty("envelope");
    expect(res.content[0]!.text).toContain("cart-1");
  });

  test("buy maps the snake_case tool input to a canonical BuyRequest and delegates", async () => {
    const { client, calls } = fakeClient();
    const buy = buildTools(client).find((t) => t.name === "buy")!;
    await buy.handler({
      idempotency_key: "buy-1",
      rail: "ucp",
      merchant: "shop.example",
      currency: "USD",
      lines: [{ id: "sku-1", quantity: 1 }],
      purpose: "office-supplies",
      terms: wireIntent.terms,
      envelope: wireIntent.envelope,
    } as never);
    expect(calls.buy).toHaveLength(1);
    const req = calls.buy[0]!;
    expect(req.idempotencyKey).toBe("buy-1");
    // The shared terms/envelope mappers must produce the same camelCase shape `pay` gets:
    // the envelope is signed material and the same gate evaluates both verbs.
    expect(req.terms.capitalSource).toBe("payer");
    expect(req.envelope.mandateId).toBe("m1");
    expect(req.envelope.grant.agentId).toBe("did:example:agent");
    // No amount crosses the boundary — the price is the merchant's, off the cart.
    expect(req).not.toHaveProperty("amount");
  });

  test("commerce refuses a rail that is not a checkout protocol", async () => {
    const { client, calls } = fakeClient();
    const quote = buildTools(client).find((t) => t.name === "quote")!;
    // `x402` is a valid RailId but not a checkout protocol; it is refused at the boundary
    // rather than dispatched to a merchant that cannot speak it.
    const res = await quote.handler({
      rail: "x402",
      merchant: "shop.example",
      currency: "USD",
      lines: [{ id: "sku-1", quantity: 1 }],
    } as never);
    expect(calls.quote).toHaveLength(0);
    expect(res.structuredContent?.code).toBe("intent.malformed");
  });

  test("commerce refuses a non-positive quantity", async () => {
    const { client, calls } = fakeClient();
    const buy = buildTools(client).find((t) => t.name === "buy")!;
    const res = await buy.handler({
      idempotency_key: "buy-2",
      rail: "acp",
      merchant: "shop.example",
      currency: "USD",
      lines: [{ id: "sku-1", quantity: 0 }],
      purpose: "office-supplies",
      terms: wireIntent.terms,
      envelope: wireIntent.envelope,
    } as never);
    expect(calls.buy).toHaveLength(0);
    expect(res.structuredContent?.code).toBe("intent.malformed");
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

  test("verify relays the decision's named checks so an agent can branch on ids", async () => {
    const { client } = fakeClient({
      outcome: "deny",
      reasons: ["payee not on the mandate"],
      mandateId: "m1",
      checks: [
        { id: "mandate.active", passed: true },
        { id: "mandate.payee_allowed", passed: false },
      ],
    });
    const verify = buildTools(client).find((t) => t.name === "verify")!;
    const res = await verify.handler({
      disclosure: {
        document: {},
        signature: { algorithm: "ed25519", public_key: "cp", value: "s" },
      },
    } as never);

    const result = (res.structuredContent as { result: Decision }).result;
    expect(result.checks?.filter((c) => !c.passed).map((c) => c.id)).toEqual([
      "mandate.payee_allowed",
    ]);
    // Text content is what a text-only host reads; the ids have to survive there too.
    expect(res.content[0]!.text).toContain("mandate.payee_allowed");
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

  test("success results keep the untouched `result` shape and no isError", async () => {
    const { client } = fakeClient();
    const pay = buildTools(client).find((t) => t.name === "pay")!;
    const res = await pay.handler({ intent: wireIntent } as never);
    expect(res.isError).toBeUndefined();
    expect((res.structuredContent as { result: Receipt }).result.reference).toBe("0xabc");
  });
});

const wireMandate = {
  namespace: "ops",
  can_read: true,
  can_write: true,
  can_erase: false,
  as_of_floor: "2026-01-01T00:00:00Z",
};

function tool(client: GeneralLiquidity & Commerce, name: string) {
  return buildTools(client).find((t) => t.name === name)!;
}

describe("memory verbs", () => {
  test("memory_remember maps the snake_case mandate and record onto the client", async () => {
    const { client, calls } = fakeClient();
    const res = await tool(client, "memory_remember").handler({
      mandate: wireMandate,
      body: { note: "counterparty prefers x402" },
      valid_from: "2026-02-01T00:00:00Z",
      valid_to: null,
      edges: [{ relation: "about", to: "rec-0" }],
      source: "agent",
    } as never);

    expect(res.isError).toBeUndefined();
    expect(calls.memoryRemember).toHaveLength(1);
    const req = calls.memoryRemember[0]!;
    expect(req.mandate).toEqual({
      namespace: "ops",
      canRead: true,
      canWrite: true,
      canErase: false,
      asOfFloor: "2026-01-01T00:00:00Z",
    });
    expect(req.validFrom).toBe("2026-02-01T00:00:00Z");
    expect(req.validTo).toBeNull();
    expect(req.edges).toEqual([{ relation: "about", to: "rec-0" }]);
    expect(req.source).toBe("agent");
  });

  test("memory_recall sends pagination beside the sealed request, not inside it", async () => {
    const { client, calls } = fakeClient();
    await tool(client, "memory_recall").handler({
      mandate: wireMandate,
      valid_at: "2026-02-01T00:00:00Z",
      tx_at: "2026-02-02T00:00:00Z",
      namespace: "ops",
      cursor: "c1",
      limit: 25,
    } as never);

    const { req, page } = calls.memoryRecall[0]!;
    expect(req.validAt).toBe("2026-02-01T00:00:00Z");
    expect(req.txAt).toBe("2026-02-02T00:00:00Z");
    expect(req.namespace).toBe("ops");
    expect(page).toEqual({ cursor: "c1", limit: 25 });
    // The cursor cannot ride inside the body the seal covers.
    expect(req).not.toHaveProperty("cursor");
    expect(req).not.toHaveProperty("limit");
  });

  test("memory_recall omits pagination entirely when the agent supplied none", async () => {
    const { client, calls } = fakeClient();
    await tool(client, "memory_recall").handler({
      mandate: wireMandate,
      valid_at: "2026-02-01T00:00:00Z",
      tx_at: "2026-02-02T00:00:00Z",
    } as never);
    expect(calls.memoryRecall[0]!.page).toEqual({});
  });

  test("memory_assemble maps the token budget and recall window", async () => {
    const { client, calls } = fakeClient();
    await tool(client, "memory_assemble").handler({
      mandate: wireMandate,
      recall: { valid_at: "2026-02-01T00:00:00Z", tx_at: "2026-02-02T00:00:00Z" },
      budget: { max_tokens: 4000 },
    } as never);

    const req = calls.memoryAssemble[0]!;
    expect(req.budget).toEqual({ maxTokens: 4000 });
    expect(req.recall).toEqual({ validAt: "2026-02-01T00:00:00Z", txAt: "2026-02-02T00:00:00Z" });
    expect(req.snapshot).toBeUndefined();
  });

  test("memory_verify passes the artifact through unwrapped", async () => {
    const { client, calls } = fakeClient();
    const artifact = { records: [], seal: { hash: "h", signature: "s" } };
    const res = await tool(client, "memory_verify").handler({ artifact } as never);
    expect(calls.memoryVerify).toEqual([artifact]);
    expect((res.structuredContent as { result: { valid: boolean } }).result.valid).toBe(true);
  });

  test("a mandate missing a capability flag is rejected before the client is reached", async () => {
    const { client, calls } = fakeClient();
    const res = await tool(client, "memory_remember").handler({
      mandate: { namespace: "ops", can_read: true },
      valid_from: "2026-02-01T00:00:00Z",
      valid_to: null,
      source: "agent",
    } as never);
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.["code"]).toBe("intent.malformed");
    expect(calls.memoryRemember).toHaveLength(0);
  });
});

describe("get_mandate", () => {
  test("delegates and needs no arguments", async () => {
    const { client, calls } = fakeClient();
    const tool = buildTools(client).find((t) => t.name === "get_mandate")!;
    const res = await tool.handler({} as never);
    expect(calls.getMandate).toBe(1);
    // No live authority is an answer, not an error: an agent needs to learn it may spend
    // nothing HERE, rather than by proposing a payment and being refused. It comes back as a
    // successful empty result, never as a problem.
    expect(res.structuredContent).toEqual({ result: [] });
    expect(res.isError).toBeUndefined();
  });

  test("its description warns that an absent budget is unknown, not zero", () => {
    // The one way a model can lose money with this tool is by reading an absent `remaining`
    // as zero-spent and concluding it holds its whole budget at the moment it holds none.
    const { client } = fakeClient();
    const tool = buildTools(client).find((t) => t.name === "get_mandate")!;
    expect(tool.description).toContain("ABSENT");
    expect(tool.description.toLowerCase()).toContain("never zero");
  });
});

describe("structured failures through the tool surface", () => {
  test("a denied pay comes back as a problem, not a thrown string", async () => {
    const { client } = fakeClient();
    const denying: GeneralLiquidity & Commerce = {
      ...client,
      async pay() {
        throw Object.assign(new Error("denied"), {
          name: "DeniedError",
          type: "intent.denied",
          problem: {
            code: "intent.denied",
            detail: "The gate denied intent idem-1.",
            reasons: ["payee not on the mandate"],
          },
        });
      },
    };
    const res = await tool(denying, "pay").handler({ intent: wireIntent } as never);
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.["code"]).toBe("intent.denied");
    expect(res.structuredContent?.["action"]).toBe("escalate-to-human");
  });

  test("a confirm verdict parks and names the intent an operator must release", async () => {
    const { client } = fakeClient();
    const parking: GeneralLiquidity & Commerce = {
      ...client,
      async pay(intent) {
        throw Object.assign(new Error("parked"), {
          name: "ApprovalPendingError",
          problem: {
            code: "approval.pending",
            detail: `Intent ${intent.idempotencyKey} is parked pending operator approval.`,
            reasons: ["velocity: 4 payments in 10 minutes"],
            approval: { intentId: intent.idempotencyKey, challenge: "chal-9f2", mandateId: "m1" },
          },
        });
      },
    };
    const res = await tool(parking, "pay").handler({ intent: wireIntent } as never);
    const data = res.structuredContent?.["data"] as {
      approval: { intentId: string; challenge: string; mandateId?: string };
      status: number;
    };
    expect(res.structuredContent?.["code"]).toBe("approval.pending");
    expect(data.approval).toEqual({ intentId: "idem-1", challenge: "chal-9f2", mandateId: "m1" });
    expect(data.status).toBe(202);
  });

  test("a memory refusal keeps its own code rather than collapsing to internal", async () => {
    const { client } = fakeClient();
    const refusing: GeneralLiquidity & Commerce = {
      ...client,
      async memoryRemember() {
        throw Object.assign(new Error("tainted source"), {
          problem: { code: "memory.denied", detail: "The engine refused a tainted write." },
        });
      },
    };
    const res = await tool(refusing, "memory_remember").handler({
      mandate: wireMandate,
      body: {},
      valid_from: "2026-02-01T00:00:00Z",
      valid_to: null,
      source: "scraper",
    } as never);
    expect(res.structuredContent?.["code"]).toBe("memory.denied");
  });

  test("a read failure is structured too", async () => {
    const { client } = fakeClient();
    const missing: GeneralLiquidity & Commerce = {
      ...client,
      async getJob() {
        throw Object.assign(new Error("no such intent"), {
          type: "not-found",
          problem: { type: "not-found", detail: "No intent with that key." },
        });
      },
    };
    const res = await tool(missing, "get_job").handler({ id: "nope" } as never);
    expect(res.structuredContent?.["code"]).toBe("not_found");
    expect(res.structuredContent?.["action"]).toBe("never-retry");
  });
});

describe("read-back verbs", () => {
  test("get_job delegates the intent key", async () => {
    const { client, calls } = fakeClient();
    const res = await tool(client, "get_job").handler({ id: "idem-1" } as never);
    expect(calls.getJob).toEqual(["idem-1"]);
    expect((res.structuredContent as { result: { status: string } }).result.status).toBe("settled");
  });

  test("get_job_events forwards the cursor page", async () => {
    const { client, calls } = fakeClient();
    await tool(client, "get_job_events").handler({ id: "idem-1", cursor: "c1", limit: 5 } as never);
    expect(calls.getJobEvents[0]).toEqual({ id: "idem-1", query: { cursor: "c1", limit: 5 } });
  });

  test("get_audit passes an empty page when the agent supplied none", async () => {
    const { client, calls } = fakeClient();
    await tool(client, "get_audit").handler({} as never);
    expect(calls.getAudit).toEqual([{}]);
  });

  test("get_usage forwards the window and its tag filter", async () => {
    const { client, calls } = fakeClient();
    await tool(client, "get_usage").handler({
      since: "2026-01-01T00:00:00Z",
      until: "2026-02-01T00:00:00Z",
      tags: ["prod"],
    } as never);
    expect(calls.getUsage[0]).toEqual({
      since: "2026-01-01T00:00:00Z",
      until: "2026-02-01T00:00:00Z",
      tags: ["prod"],
    });
  });

  test("get_usage without a window fails validation instead of reaching the client", async () => {
    const { client, calls } = fakeClient();
    const res = await tool(client, "get_usage").handler({} as never);
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.["code"]).toBe("intent.malformed");
    expect(calls.getUsage).toHaveLength(0);
  });
});
