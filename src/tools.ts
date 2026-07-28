// The curated projection. Four task-shaped verbs — resolve · pay · verify · disclose —
// mapped 1:1 onto the @general-liquidity/sdk `GeneralLiquidity` methods. This is a
// coarse-grained surface, NOT a dump of every internal operation. Tool params are
// snake_case and the surface takes camelCase, so each handler maps at the seam. That
// snake_case is an LLM tool-input vocabulary, NOT the wire: the wire is camelCase, and this
// mapping exists only because these names are what a model is prompted with. Nothing here
// reaches the HTTP boundary, which the client crosses unrenamed. Signing/settlement stay
// behind the injected client, so the MCP layer never fabricates a settle primitive.

import type { Disclosure, GeneralLiquidity, Intent } from "@general-liquidity/sdk";
import { z } from "zod";

/** MCP `CallToolResult`, kept local so we don't depend on SDK internals for the shape. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

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

const termsShape = z.object({
  reversibility: z.enum(["reversible", "irreversible"]),
  finality: z.enum(["instant", "deferred"]),
  credential: z.string(),
  rail: z.enum(["x402", "mpp", "ap2", "acp", "ucp", "card", "onchain"]),
  capital_source: z.enum(["payer", "facilitator", "merchant_of_record", "solver"]),
  presence: z.enum(["present", "delegated"]),
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

function ok(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: { result: value },
  };
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
      handler: async (args) => {
        const { ref } = z.object({ ref: z.string() }).parse(args);
        return ok(await client.resolve(ref));
      },
    },
    {
      name: "pay",
      description:
        "Submit a signed Intent to move value. The sovereign gate decides; on allow it settles on the right rail and returns a Receipt. The caller never holds a settle primitive.",
      inputSchema: { intent: intentShape },
      handler: async (args) => {
        const { intent } = z.object({ intent: intentShape }).parse(args);
        return ok(await client.pay(toIntent(intent)));
      },
    },
    {
      name: "verify",
      description:
        "Check a counterparty's signed disclosure against policy (identity + provenance + enforcement proof), returning a Decision.",
      inputSchema: { disclosure: disclosureShape },
      handler: async (args) => {
        const { disclosure } = z.object({ disclosure: disclosureShape }).parse(args);
        return ok(await client.verify(toDisclosure(disclosure)));
      },
    },
    {
      name: "disclose",
      description:
        "Produce GL's own signed disclosure: what this agent is and what it is authorized to do.",
      inputSchema: {},
      handler: async () => ok(await client.disclose()),
    },
  ];
}

/** The curated verb set this server projects. Stable, small, task-shaped. */
export const TOOL_NAMES = ["resolve", "pay", "verify", "disclose"] as const;
