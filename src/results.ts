// Tool results, machine-readable in BOTH directions. Success keeps the shape it always had
// (`structuredContent.result`); failure carries the same RFC 9457 problem the REST surface
// emits, so an agent branches on `structuredContent.code` instead of scraping prose.
//
// The taxonomy is NOT redefined here: it comes from ./problem.ts, which mirrors the
// platform's `@general-liquidity/surface` vocabulary because that package is unpublished
// (see the header there). This file owns one extra job the platform's copy does not need:
// the injected `@general-liquidity/sdk` client throws its OWN error taxonomy — legacy
// slugs ("denied", "rate-limited", "validation") and `GlError` subclasses — so a thrown
// SDK failure has to be BRIDGED onto the shared codes rather than passed through. A modern
// server response already carries `problem.code`, and that always wins; the bridge only
// catches an older peer or an SDK-classified failure that never reached the wire.

import { z } from "zod";
import {
  type ErrorAction,
  nextStep,
  type PendingApproval,
  type Problem,
  type ProblemCode,
  problem,
} from "./problem.ts";

/** MCP `CallToolResult`, kept local so we don't depend on SDK internals for the shape. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** The failure payload an agent reads: the stable code, prose, and the actionable fields. */
export interface StructuredError {
  code: ProblemCode;
  message: string;
  /** What to do next. Switch on this, not on `code`: the four classes are closed, codes grow. */
  action: ErrorAction;
  data: Record<string, unknown>;
}

export function ok(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: { result: value },
  };
}

/** Turn a problem into an error result. Text content is kept for text-only clients. */
export function fail(p: Problem, hint?: string): ToolResult {
  const structured: StructuredError = {
    code: p.code,
    message: p.detail,
    action: p.action,
    data: {
      type: p.type,
      status: p.status,
      // `action` is the field to branch on and `retryable` is derived from it, so they travel
      // together. A boolean alone cannot tell an agent to renegotiate rather than loop.
      action: p.action,
      nextStep: nextStep(p),
      retryable: p.retryable,
      ...(p.reasons ? { reasons: p.reasons } : {}),
      ...(p.retryAfter !== undefined ? { retryAfter: p.retryAfter } : {}),
      ...(p.approval ? { approval: p.approval } : {}),
      // Present on `state.stale`: the token the peer actually holds, so the caller can re-read
      // and resubmit the identical request instead of guessing what moved.
      ...(p.currentStateToken !== undefined ? { currentStateToken: p.currentStateToken } : {}),
    },
  };
  const text = `${p.title}: ${p.detail}${hint ? ` ${hint}` : ""}`;
  return {
    content: [{ type: "text", text }],
    structuredContent: structured as unknown as Record<string, unknown>,
    isError: true,
  };
}

export function failWith(
  code: ProblemCode,
  detail: string,
  extra?: { reasons?: string[]; retryAfter?: number; approval?: PendingApproval },
): ToolResult {
  return fail(problem(code, detail, extra));
}

/**
 * The `confirm`-tier result: the gate parked the intent for a human. Everything needed to
 * NAME the parked payment is on the problem, so the operator needs no second lookup. The
 * challenge names it; it is not authority to release it, and this server exposes no verb
 * that could — release happens through the operator credential channel, off this surface.
 */
export function parked(approval: PendingApproval, reasons: string[]): ToolResult {
  const p = problem(
    "approval.pending",
    `Intent ${approval.intentId} is parked pending operator approval.`,
    { reasons, approval },
  );
  return fail(
    p,
    `Release requires an operator: intent_id="${approval.intentId}", ` +
      `challenge="${approval.challenge}". This agent surface cannot approve it.`,
  );
}

/**
 * Every code the taxonomy defines. Written as an exhaustive record rather than a bare list
 * so the compiler, not a reviewer, catches a code added upstream: a code missing here is
 * silently downgraded to `internal`, which is how `state.stale` would reach an agent as an
 * unexplained server error instead of "re-read and resubmit".
 */
const CODE_IS_KNOWN: Record<ProblemCode, true> = {
  "intent.unparseable": true,
  "intent.malformed": true,
  "intent.denied": true,
  "approval.pending": true,
  "enforcement.mismatch": true,
  "rail.unavailable": true,
  "principal.unauthorized": true,
  "operator.unauthorized": true,
  "operator.refused": true,
  "memory.denied": true,
  "memory.forbidden": true,
  "memory.pending": true,
  "state.stale": true,
  "state.malformed": true,
  not_found: true,
  method_not_allowed: true,
  unsupported_media_type: true,
  payload_too_large: true,
  rate_limited: true,
  quota_exceeded: true,
  internal: true,
};

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.keys(CODE_IS_KNOWN));

/**
 * The SDK's own slugs (`internal/errors.ts` BY_TYPE) mapped onto the shared taxonomy. These
 * are what an older peer, or a peer whose `type` predates the `code` extension member,
 * puts on the wire. Every entry preserves the ACTION class, which is the field agents
 * branch on: a mandate breach and an insufficient balance are both policy refusals a retry
 * cannot fix, an idempotency conflict is a request defect, a stale-vs-parked distinction is
 * never collapsed.
 */
const LEGACY_CODE: Record<string, ProblemCode> = {
  denied: "intent.denied",
  deny: "intent.denied",
  // A mandate breach is a policy refusal, not a request defect: the same intent under the
  // same mandate always loses. Same action class as a gate deny, so the same code.
  "mandate-exceeded": "intent.denied",
  // No taxonomy code for funds. An agent cannot top up its own balance, so this is the
  // escalate-to-human class, which `intent.denied` is.
  "insufficient-funds": "intent.denied",
  "approval-pending": "approval.pending",
  // The optional PENDING clearing band HELD a bound spend: gated and authorized, awaiting
  // admissible evidence, and it auto-releases. That is exactly "retry as is once the rail
  // finalizes", the class `rail.unavailable` carries. It is deliberately NOT mapped to
  // `approval.pending`: nothing here waits on a human.
  "clearing.pending": "rail.unavailable",
  "clearing-pending": "rail.unavailable",
  validation: "intent.malformed",
  // Reusing an idempotency key with a different body: an identical retry can never succeed,
  // which is the never-retry class, not a lost race on state.
  "idempotency-conflict": "intent.malformed",
  unauthorized: "principal.unauthorized",
  forbidden: "principal.unauthorized",
  "rate-limited": "rate_limited",
  "rate-limit": "rate_limited",
  "not-found": "not_found",
  "server-error": "internal",
};

/**
 * Last resort: the SDK's error CLASS. Keyed on `name` rather than `instanceof` because a
 * `github:` dependency can be present in more than one copy, and constructor identity does
 * not survive that while `GlError`'s `name` (set from `new.target.name`) does.
 */
const ERROR_NAME_CODE: Record<string, ProblemCode> = {
  DeniedError: "intent.denied",
  MandateExceededError: "intent.denied",
  InsufficientFundsError: "intent.denied",
  ApprovalPendingError: "approval.pending",
  PendingSettlementError: "rail.unavailable",
  ValidationError: "intent.malformed",
  IdempotencyConflictError: "intent.malformed",
  AuthError: "principal.unauthorized",
  RateLimitError: "rate_limited",
  QuotaExceededError: "quota_exceeded",
  ServerError: "internal",
};

const pendingApproval = z.object({
  intentId: z.string(),
  challenge: z.string(),
  mandateId: z.string().optional(),
});

/** Anything a client may throw: the SDK's `GlError` shape, with its problem body optional. */
const thrownError = z.object({
  name: z.string().optional(),
  message: z.string().optional(),
  /** `GlError.type`: the trailing segment of the problem type, i.e. the SDK's slug. */
  type: z.string().optional(),
  retryAfterMs: z.number().optional(),
  problem: z
    .object({
      code: z.string().optional(),
      type: z.string().optional(),
      detail: z.string().optional(),
      title: z.string().optional(),
      reasons: z.array(z.string()).optional(),
      approval: pendingApproval.optional(),
      currentStateToken: z.string().optional(),
    })
    .optional(),
});

/** Trailing segment of a problem `type` URI, which is the stable code. */
function codeFromType(type: string | undefined): string | undefined {
  if (!type || type === "about:blank") return undefined;
  return (
    type
      .replace(/[/#]+$/, "")
      .split(/[/#]/)
      .pop() || undefined
  );
}

/** Resolve the shared-taxonomy code for a raw slug, or undefined when it is not one. */
function resolveCode(raw: string | undefined): ProblemCode | undefined {
  if (!raw) return undefined;
  if (KNOWN_CODES.has(raw)) return raw as ProblemCode;
  return LEGACY_CODE[raw];
}

/**
 * Map anything a client throws onto a structured error. A problem body's own `code` is
 * preserved verbatim (including a parked approval); an SDK slug or error class is bridged
 * onto the shared taxonomy; anything else degrades to `internal`.
 */
export function failFromThrown(error: unknown): ToolResult {
  const parsed = thrownError.safeParse(error);
  const e = parsed.success ? parsed.data : undefined;
  const body = e?.problem;

  const code =
    resolveCode(body?.code) ??
    resolveCode(codeFromType(body?.type)) ??
    resolveCode(e?.type) ??
    (e?.name ? ERROR_NAME_CODE[e.name] : undefined);

  if (!code) {
    return failWith("internal", error instanceof Error ? error.message : String(error));
  }

  const detail = body?.detail ?? body?.title ?? e?.message ?? "The call failed.";
  if (code === "approval.pending" && body?.approval) {
    return parked(body.approval, body.reasons ?? []);
  }
  return fail(
    problem(code, detail, {
      ...(body?.reasons ? { reasons: body.reasons } : {}),
      ...(body?.approval ? { approval: body.approval } : {}),
      ...(body?.currentStateToken !== undefined
        ? { currentStateToken: body.currentStateToken }
        : {}),
      // The SDK decodes `Retry-After` into milliseconds; the problem body carries seconds.
      // `problem()` drops it on a code that is not retryable, so no guard is needed here.
      ...(e?.retryAfterMs !== undefined ? { retryAfter: Math.ceil(e.retryAfterMs / 1000) } : {}),
    }),
  );
}
