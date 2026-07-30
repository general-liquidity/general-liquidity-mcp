// The curated projection. Task-shaped verbs mapped 1:1 onto the @general-liquidity/sdk
// `GeneralLiquidity` methods, in three groups: money/identity (resolve · pay · verify ·
// disclose), memory (remember · recall · assemble · verify) and read-back (job · job events
// · audit · usage). This is a coarse-grained surface, NOT a dump of every internal
// operation. Tool params are snake_case and the surface takes camelCase, so each handler
// maps at the seam. That snake_case is an LLM tool-input vocabulary, NOT the wire: the wire
// is camelCase, and this mapping exists only because these names are what a model is
// prompted with. Nothing here reaches the HTTP boundary, which the client crosses unrenamed.
// Signing/settlement stay behind the injected client, so the MCP layer never fabricates a
// settle primitive.
//
// Failures are structured, not prose: every handler returns the same RFC 9457 problem the
// REST surface emits, on `structuredContent`, so an agent can branch on the code. A
// `confirm` verdict is one of those problems (`approval.pending`) and carries the parked
// intent id + challenge, which is what an operator needs to release it out-of-band.
//
// OPERATOR VERBS ARE ABSENT BY CONSTRUCTION. There is no `approve`, no `refund`, no kill
// switch and no `memory_forget` here. Those routes live in a disjoint authorization domain
// (the detached `GL-Operator` ed25519 credential), which the injected agent client cannot
// mint: it holds an agent signer, not operator authority. Exposing them as tools would
// either be dead (the call always fails auth) or, worse, would let an agent release its own
// parked spend. An agent that can approve its own payment has no gate.

import type {
  Disclosure,
  GeneralLiquidity,
  Intent,
  MemoryMandate,
  Snapshot,
} from "@general-liquidity/sdk";
import { z } from "zod";
import { failFromThrown, failWith, ok, type ToolResult } from "./results.ts";

export type { StructuredError, ToolResult } from "./results.ts";

/** One registered tool: its wire name, description, zod input shape, and delegating handler. */
export interface ToolDef<Shape extends z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>;
}

/** Erased tool def — the runtime-facing shape `buildTools` returns and the server registers. */
export interface AnyToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

const amountShape = z.object({
  value: z.string(),
  asset: z.string(),
});

// The closed Terms vocabularies the tool schema advertises to a model. Each is checked
// against the SDK wire contract in BOTH directions at compile time: `satisfies` rejects a
// value the SDK does not know, and the `AssertNever` line below each rejects an SDK value
// the literal has not enumerated. A rail added to the SDK and not added here is a type
// error in this file, not a tool schema that quietly refuses a valid rail.
type Terms = Intent["terms"];

/** Compile-time proof that a union is empty. Instantiating it with a leftover member errors. */
type AssertNever<T extends never> = T;

/** The SDK members a literal failed to enumerate. `never` when the literal is exhaustive. */
type Uncovered<Union, Literal extends readonly unknown[]> = Exclude<Union, Literal[number]>;

const RAILS = [
  "x402",
  "mpp",
  "ap2",
  "acp",
  "ucp",
  "card",
  "onchain",
  "l402",
  "ach",
  "wire",
] as const satisfies readonly Terms["rail"][];
export type UncoveredRails = AssertNever<Uncovered<Terms["rail"], typeof RAILS>>;

const REVERSIBILITY = [
  "reversible",
  "irreversible",
] as const satisfies readonly Terms["reversibility"][];
export type UncoveredReversibility = AssertNever<
  Uncovered<Terms["reversibility"], typeof REVERSIBILITY>
>;

const FINALITY = ["instant", "deferred"] as const satisfies readonly Terms["finality"][];
export type UncoveredFinality = AssertNever<Uncovered<Terms["finality"], typeof FINALITY>>;

const CAPITAL_SOURCE = [
  "payer",
  "facilitator",
  "merchant_of_record",
  "solver",
] as const satisfies readonly Terms["capitalSource"][];
export type UncoveredCapitalSource = AssertNever<
  Uncovered<Terms["capitalSource"], typeof CAPITAL_SOURCE>
>;

const PRESENCE = ["present", "delegated"] as const satisfies readonly Terms["presence"][];
export type UncoveredPresence = AssertNever<Uncovered<Terms["presence"], typeof PRESENCE>>;

const termsShape = z.object({
  reversibility: z.enum(REVERSIBILITY),
  finality: z.enum(FINALITY),
  credential: z.string(),
  rail: z.enum(RAILS),
  capital_source: z.enum(CAPITAL_SOURCE),
  presence: z.enum(PRESENCE),
});

const grantShape = z.object({
  agent_id: z.string(),
  mandate_id: z.string(),
  expires_at: z.string(),
  signature: z.string(),
});

const envelopeShape = z.object({
  identity: z.string(),
  mandate_id: z.string(),
  grant: grantShape,
  signature: z.string(),
});

const intentShape = z.object({
  idempotency_key: z.string(),
  payee: z.string(),
  amount: amountShape,
  purpose: z.string(),
  terms: termsShape,
  envelope: envelopeShape,
});

const keyRotationStatementShape = z.object({
  type: z.literal("rotation"),
  from: z.string(),
  to: z.string(),
  rotated_at: z.string(),
  signature: z.string(),
});

const disclosureShape = z.object({
  document: z.record(z.string(), z.unknown()),
  signature: z.object({
    algorithm: z.literal("ed25519"),
    public_key: z.string(),
    value: z.string(),
  }),
  rotation_chain: z.array(keyRotationStatementShape).optional(),
});

type WireIntent = z.infer<typeof intentShape>;
type WireDisclosure = z.infer<typeof disclosureShape>;

/** snake_case wire → canonical camelCase `Intent`. The one seam that owns the mapping. */
function toIntent(wire: WireIntent): Intent {
  return {
    idempotencyKey: wire.idempotency_key,
    payee: wire.payee,
    amount: wire.amount,
    purpose: wire.purpose,
    terms: {
      reversibility: wire.terms.reversibility,
      finality: wire.terms.finality,
      credential: wire.terms.credential,
      rail: wire.terms.rail,
      capitalSource: wire.terms.capital_source,
      presence: wire.terms.presence,
    },
    envelope: {
      identity: wire.envelope.identity,
      mandateId: wire.envelope.mandate_id,
      grant: {
        agentId: wire.envelope.grant.agent_id,
        mandateId: wire.envelope.grant.mandate_id,
        expiresAt: wire.envelope.grant.expires_at,
        signature: wire.envelope.grant.signature,
      },
      signature: wire.envelope.signature,
    },
  };
}

function toDisclosure(wire: WireDisclosure): Disclosure {
  return {
    document: wire.document,
    signature: {
      algorithm: wire.signature.algorithm,
      publicKey: wire.signature.public_key,
      value: wire.signature.value,
    },
    ...(wire.rotation_chain
      ? {
          rotationChain: wire.rotation_chain.map((r) => ({
            type: r.type,
            from: r.from,
            to: r.to,
            rotatedAt: r.rotated_at,
            signature: r.signature,
          })),
        }
      : {}),
  };
}

/** A memory mandate as the agent presents it: scope + per-op capabilities + an as-of floor. */
const memoryMandateShape = z.object({
  namespace: z.string(),
  can_read: z.boolean(),
  can_write: z.boolean(),
  can_erase: z.boolean(),
  as_of_floor: z.string().optional(),
});

const memoryEdgeShape = z.object({ relation: z.string(), to: z.string() });

type WireMemoryMandate = z.infer<typeof memoryMandateShape>;

/** snake_case wire mandate → the camelCase shape the client takes. */
function toMemoryMandate(wire: WireMemoryMandate): MemoryMandate {
  return {
    namespace: wire.namespace,
    canRead: wire.can_read,
    canWrite: wire.can_write,
    canErase: wire.can_erase,
    ...(wire.as_of_floor !== undefined ? { asOfFloor: wire.as_of_floor } : {}),
  };
}

const rememberShape = {
  mandate: memoryMandateShape,
  body: z.unknown(),
  valid_from: z.string(),
  valid_to: z.string().nullable(),
  edges: z.array(memoryEdgeShape).optional(),
  source: z.string(),
};

const recallShape = {
  mandate: memoryMandateShape,
  valid_at: z.string(),
  tx_at: z.string(),
  namespace: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().optional(),
};

const assembleShape = {
  mandate: memoryMandateShape,
  snapshot: z.unknown().optional(),
  recall: z.object({ valid_at: z.string(), tx_at: z.string() }).optional(),
  budget: z.object({ max_tokens: z.number() }),
  namespace: z.string().optional(),
};

const memoryVerifyShape = { artifact: z.unknown() };

const pageShape = {
  cursor: z.string().optional(),
  limit: z.number().optional(),
};

const usageShape = {
  since: z.string(),
  until: z.string(),
  tags: z.array(z.string()).optional(),
};

/**
 * Every handler funnels its failures through the structured-problem shape: a thrown SDK
 * error becomes the same RFC 9457 problem the REST surface emits, and a schema failure
 * becomes `intent.malformed` carrying the offending paths, rather than a raw ZodError
 * crossing the transport as prose.
 */
async function guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof z.ZodError) {
      return failWith("intent.malformed", "Tool arguments failed validation.", {
        reasons: err.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
      });
    }
    return failFromThrown(err);
  }
}

/**
 * Build the curated tool set bound to an injected `GeneralLiquidity` client. Exported
 * separately from the server so tests can assert registration + delegation with a fake
 * client and no transport.
 */
export function buildTools(client: GeneralLiquidity): AnyToolDef[] {
  // Handlers parse args through the tool's own zod schema, so delegation is type-safe at
  // authoring time and validated at runtime even when a transport skips validation.
  return [
    {
      name: "resolve",
      description:
        "Normalize any counterparty reference (A2A card · signed disclosure · CAIP) into one identity with its accepted rails and trust signals.",
      inputSchema: { ref: z.string() },
      handler: (args) =>
        guarded(async () => {
          const { ref } = z.object({ ref: z.string() }).parse(args);
          return ok(await client.resolve(ref));
        }),
    },
    {
      name: "pay",
      description:
        "Submit a signed Intent to move value. The sovereign gate decides; on allow it settles on the right rail and returns a Receipt. A confirm verdict is not a Receipt: it comes back as an approval.pending problem carrying the parked intent id and its challenge, which only an operator can release. The caller never holds a settle primitive.",
      inputSchema: { intent: intentShape },
      handler: (args) =>
        guarded(async () => {
          const { intent } = z.object({ intent: intentShape }).parse(args);
          return ok(await client.pay(toIntent(intent)));
        }),
    },
    {
      name: "verify",
      description:
        "Check a counterparty's signed disclosure against policy (identity + provenance + enforcement proof), returning a Decision. The Decision's `checks` name every policy predicate the gate evaluated and whether each passed; branch on those ids, not on the prose in `reasons`.",
      inputSchema: { disclosure: disclosureShape },
      handler: (args) =>
        guarded(async () => {
          const { disclosure } = z.object({ disclosure: disclosureShape }).parse(args);
          return ok(await client.verify(toDisclosure(disclosure)));
        }),
    },
    {
      name: "disclose",
      description:
        "Produce GL's own signed disclosure: what this agent is and what it is authorized to do.",
      inputSchema: {},
      handler: () => guarded(async () => ok(await client.disclose())),
    },

    // Memory. Four verbs, mirroring the `/memory/*` routes an agent may call. `forget` is
    // deliberately absent and the injected client has no method for it: cascading erasure is
    // operator-privileged on the server, in the same credential domain as approve and the
    // kill switch.
    {
      name: "memory_remember",
      description:
        "Write one bi-temporal memory record under a mandate. The engine gates the write: on allow it returns the signed record; a parked write comes back as memory.pending and a refusal as memory.denied / memory.forbidden. No-lookahead: the record is valid from `valid_from` and never reveals a future edit.",
      inputSchema: rememberShape,
      handler: (args) =>
        guarded(async () => {
          const a = z.object(rememberShape).parse(args);
          return ok(
            await client.memoryRemember({
              mandate: toMemoryMandate(a.mandate),
              body: a.body,
              validFrom: a.valid_from,
              validTo: a.valid_to,
              ...(a.edges ? { edges: a.edges } : {}),
              source: a.source,
            }),
          );
        }),
    },
    {
      name: "memory_recall",
      description:
        "Read a point-in-time snapshot: the records valid at `valid_at` as known at `tx_at`, under one seal. Cursor-paginated; the seal covers the complete snapshot, not just the page. A recall reaching before the mandate's as-of floor is a memory.forbidden problem.",
      inputSchema: recallShape,
      handler: (args) =>
        guarded(async () => {
          const a = z.object(recallShape).parse(args);
          // Recall pagination is a SECOND argument on the client, not part of the request
          // body: the seal is computed over the whole snapshot, so the cursor cannot be
          // inside the sealed payload.
          return ok(
            await client.memoryRecall(
              {
                mandate: toMemoryMandate(a.mandate),
                validAt: a.valid_at,
                txAt: a.tx_at,
                ...(a.namespace !== undefined ? { namespace: a.namespace } : {}),
              },
              {
                ...(a.cursor !== undefined ? { cursor: a.cursor } : {}),
                ...(a.limit !== undefined ? { limit: a.limit } : {}),
              },
            ),
          );
        }),
    },
    {
      name: "memory_assemble",
      description:
        "Assemble a budgeted, ordered context from a snapshot (or from recall params). Returns a signed Context; abstention (the engine declining to fill the budget) is a valid result, not an error.",
      inputSchema: assembleShape,
      handler: (args) =>
        guarded(async () => {
          const a = z.object(assembleShape).parse(args);
          return ok(
            await client.memoryAssemble({
              mandate: toMemoryMandate(a.mandate),
              ...(a.snapshot !== undefined ? { snapshot: a.snapshot as Snapshot } : {}),
              ...(a.recall ? { recall: { validAt: a.recall.valid_at, txAt: a.recall.tx_at } } : {}),
              budget: { maxTokens: a.budget.max_tokens },
              ...(a.namespace !== undefined ? { namespace: a.namespace } : {}),
            }),
          );
        }),
    },
    {
      name: "memory_verify",
      description:
        "Offline verification of a signed memory artifact (record · snapshot · context · erasure proof). Free and mandate-free: it reaches no store and mutates nothing, returning the plain verdict.",
      inputSchema: memoryVerifyShape,
      handler: (args) =>
        guarded(async () => {
          const a = z.object(memoryVerifyShape).parse(args);
          return ok(await client.memoryVerify(a.artifact));
        }),
    },

    // Read-back. An agent that submitted an intent has to be able to see what became of it
    // and what it has spent, without an operator in the loop. All four are reads over the
    // calling principal's own record: they mutate nothing and grant nothing.
    {
      name: "get_job",
      description:
        "Read the lifecycle of one intent by its idempotency key: status (pending · settled · denied · failed), outcome, and the Receipt once it settled. This is how a parked intent is followed after an approval.pending result.",
      inputSchema: { id: z.string() },
      handler: (args) =>
        guarded(async () => {
          const { id } = z.object({ id: z.string() }).parse(args);
          return ok(await client.getJob(id));
        }),
    },
    {
      name: "get_job_events",
      description:
        "List one intent's signed, hash-linked audit events, oldest first, cursor-paginated. Use it to see exactly which gate checks ran and in what order.",
      inputSchema: { id: z.string(), ...pageShape },
      handler: (args) =>
        guarded(async () => {
          const a = z.object({ id: z.string(), ...pageShape }).parse(args);
          return ok(
            await client.getJobEvents(a.id, {
              ...(a.cursor !== undefined ? { cursor: a.cursor } : {}),
              ...(a.limit !== undefined ? { limit: a.limit } : {}),
            }),
          );
        }),
    },
    {
      name: "get_audit",
      description:
        "Read the signed, hash-linked audit trail across every intent for the calling principal, cursor-paginated.",
      inputSchema: pageShape,
      handler: (args) =>
        guarded(async () => {
          const a = z.object(pageShape).parse(args);
          return ok(
            await client.getAudit({
              ...(a.cursor !== undefined ? { cursor: a.cursor } : {}),
              ...(a.limit !== undefined ? { limit: a.limit } : {}),
            }),
          );
        }),
    },
    {
      name: "get_usage",
      description:
        "Read metered call counts for the calling principal over a window, broken down by operation and outcome. `since` is inclusive, `until` exclusive; `tags` counts only calls carrying EVERY listed tag.",
      inputSchema: usageShape,
      handler: (args) =>
        guarded(async () => {
          const a = z.object(usageShape).parse(args);
          return ok(
            await client.getUsage({
              since: a.since,
              until: a.until,
              ...(a.tags !== undefined ? { tags: a.tags } : {}),
            }),
          );
        }),
    },
  ];
}

/** The money + identity verbs. Stable, small, task-shaped. */
export const TOOL_NAMES = ["resolve", "pay", "verify", "disclose"] as const;

/**
 * The memory verbs. `memory_forget` is intentionally excluded: erasure is
 * operator-privileged, and the injected agent client has no method for it.
 */
export const MEMORY_TOOL_NAMES = [
  "memory_remember",
  "memory_recall",
  "memory_assemble",
  "memory_verify",
] as const;

/** The read-back verbs. Reads over the calling principal's own record; they grant nothing. */
export const READ_TOOL_NAMES = ["get_job", "get_job_events", "get_audit", "get_usage"] as const;

/** Every tool this server registers, in registration order. */
export const ALL_TOOL_NAMES = [...TOOL_NAMES, ...MEMORY_TOOL_NAMES, ...READ_TOOL_NAMES] as const;
