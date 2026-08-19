// RFC 9457 `application/problem+json` vocabulary. Every failure carries a stable
// machine-parseable `code` and an `action` class so a client (agent or SDK) can decide
// what to do next without scraping prose.
//
// WHY THIS FILE IS A DUPLICATE. The canonical taxonomy lives in the platform monorepo at
// `packages/surface/src/problem.ts`, which is a `private: true`, unpublished workspace
// package: it is not on npm and this repository cannot depend on it. This package's only
// General Liquidity dependency is `@general-liquidity/sdk` (a `github:` dependency), and
// that SDK vendors the LOOSE RFC 7807 `Problem` shape plus its own legacy error slugs
// ("denied", "rate-limited", "validation"), not the code/action/retryable taxonomy the
// REST surface actually emits. So the taxonomy is mirrored here, byte-faithfully, rather
// than invented: the literals, statuses, action classes and next-step prose below are the
// same values the hosted server sends on the wire. If `@general-liquidity/surface` is ever
// published, delete this file and import from it — nothing else has to change, because
// `results.ts` is the only consumer.

/**
 * What the caller should DO, not what went wrong. A boolean `retryable` tells an
 * autonomous caller nothing about whether to loop, renegotiate or stop, so it either
 * burns a retry loop on an unretryable failure or abandons a recoverable one. Four
 * closed classes make the next step mechanical.
 */
export type ErrorAction =
  /** Malformed or structurally impossible. An identical retry can never succeed. */
  | "never-retry"
  /** The world moved (state token stale, hold already captured). Re-read, retry as-is. */
  | "retry-as-is"
  /** A capability the call depended on was withdrawn. Re-run `negotiate/capabilities` first. */
  | "retry-after-renegotiation"
  /** Refused on policy. No amount of retrying helps; a human must decide. */
  | "escalate-to-human";

export const ALL_ERROR_ACTIONS: readonly ErrorAction[] = [
  "never-retry",
  "retry-as-is",
  "retry-after-renegotiation",
  "escalate-to-human",
];

/** The one next step each action class implies. Mechanical, so a client can branch on it. */
export const NEXT_STEP: Record<ErrorAction, string> = {
  "never-retry": "Fix the request. An identical retry can never succeed.",
  "retry-as-is": "Re-read the current state, then submit the same request again.",
  "retry-after-renegotiation": "Re-run negotiate/capabilities, then rebuild the request.",
  "escalate-to-human": "Stop. A human operator must decide; no retry helps.",
};

/** Stable machine codes. These are part of the wire contract, never renamed. */
export type ProblemCode =
  // The body could not be decoded at all: not JSON, or unreadable. Nothing about the
  // request's SHAPE was ever evaluated.
  | "intent.unparseable"
  | "intent.malformed"
  | "intent.denied"
  | "approval.pending"
  | "enforcement.mismatch"
  | "rail.unavailable"
  // The CALLING principal's own credential was absent, unreadable, or not one this
  // deployment recognizes. A different authorization domain from `operator.unauthorized`.
  | "principal.unauthorized"
  // The caller presented no operator authority, or authority this deployment does not
  // recognise. Deliberately indistinguishable from "no operator surface is configured".
  | "operator.unauthorized"
  // The operator was authorized, but the kernel refused on its own preconditions.
  | "operator.refused"
  // The memory engine denied a gated write on its own preconditions (e.g. a tainted source).
  | "memory.denied"
  // The memory mandate's scope or capability refused the operation (wrong namespace,
  // missing canRead/canWrite/canErase, or a recall reaching before the as-of floor).
  | "memory.forbidden"
  // A gated memory write was accepted but parked pending operator confirmation. A 202,
  // not a rejection: the way forward is operator release, not retry.
  | "memory.pending"
  // The caller conditioned a mutation on a global state token the kernel has moved past.
  // The mutation was NOT applied; re-read state and submit the same request again.
  | "state.stale"
  // The caller presented an `expectedStateToken` that is not a state token. The
  // never-retry twin of `state.stale`, not a variant of it.
  | "state.malformed"
  | "not_found"
  | "method_not_allowed"
  | "unsupported_media_type"
  | "payload_too_large"
  | "rate_limited"
  // Inside the request window, but the plan's call allowance is spent. Shares 429 with
  // `rate_limited` and means the opposite thing: waiting does not clear it inside any window
  // an agent is willing to wait out.
  | "quota_exceeded"
  // Another attempt under this idempotency key has not terminated. The server refused to run
  // the money path twice for one key, so this arriving means the protection worked.
  | "idempotency.in_flight"
  | "internal";

/**
 * Everything a caller needs to resume a parked (`confirm`-tier) intent without a second
 * lookup. Carried on an `approval.pending` problem. NONE of these fields is approval
 * AUTHORITY: the intent id and challenge only NAME the parked payment and bind an approval
 * to it. Releasing it still requires operator-held approval material, which never travels
 * on a problem body — and which this agent-facing server deliberately has no verb for.
 */
export interface PendingApproval {
  /** The parked intent id: what the operator `approve` route takes as its first argument. */
  intentId: string;
  /** Opaque challenge the approval must be bound to. Not a bearer credential. */
  challenge: string;
  /** The mandate the gate matched, when it matched one. */
  mandateId?: string;
}

/** The problem+json body. `code`, `action` and `retryable` are GL extension members. */
export interface Problem {
  /** Dereferenceable problem-type URI (RFC 9457 `type`). */
  type: string;
  title: string;
  status: number;
  detail: string;
  /** Stable machine code. Switch on this, not on `title`. */
  code: ProblemCode;
  /**
   * What to do next. Switch on this, not on `code`: new codes are added over time and a
   * client that branches on `code` breaks when one arrives, while the four action classes
   * are closed.
   */
  action: ErrorAction;
  /** Derived from `action`. Kept so existing clients that read a boolean still work. */
  retryable: boolean;
  /** Suggested backoff in seconds, when retryable. */
  retryAfter?: number;
  /** Extra structured context (e.g. gate reasons). */
  reasons?: string[];
  /** Set on `approval.pending`: how to resume the parked intent. */
  approval?: PendingApproval;
  /** Set on `state.stale`: the global state token the kernel actually holds. */
  currentStateToken?: string;
}

const PROBLEM_BASE = "https://docs.generalliquidity.com/problems/";

const TITLES: Record<ProblemCode, string> = {
  "intent.unparseable": "Unreadable request body",
  "intent.malformed": "Malformed intent",
  "intent.denied": "Intent denied by the gate",
  "approval.pending": "Intent parked pending operator approval",
  "enforcement.mismatch": "Enforcement proof did not verify",
  "rail.unavailable": "Settlement rail unavailable",
  "principal.unauthorized": "Authentication failed",
  "operator.unauthorized": "Operator authority required",
  "operator.refused": "Operator action refused",
  "memory.denied": "Memory write denied by the engine",
  "memory.forbidden": "Memory authorization refused",
  "memory.pending": "Memory write parked pending operator confirmation",
  "state.stale": "State moved under the caller",
  "state.malformed": "Malformed state token",
  not_found: "Not found",
  method_not_allowed: "Method not allowed",
  unsupported_media_type: "Unsupported media type",
  payload_too_large: "Request body too large",
  rate_limited: "Rate limit exceeded",
  quota_exceeded: "Plan allowance exhausted",
  "idempotency.in_flight": "Idempotency key already in flight",
  internal: "Internal error",
};

/**
 * Every code, at runtime. Derived from the title table rather than restated, so a new
 * member of the union cannot be added without appearing here: `TITLES` is a total
 * `Record<ProblemCode, string>`, so the compiler already refuses an incomplete one.
 */
export const ALL_PROBLEM_CODES: readonly ProblemCode[] = Object.keys(TITLES) as ProblemCode[];

/**
 * The caller-authentication refusal, spelled the way the rest of the taxonomy spells its
 * codes. Prefer this symbol to the bare literal so the next move has one place to happen.
 */
export const PRINCIPAL_UNAUTHORIZED = "principal.unauthorized" satisfies ProblemCode;

const STATUS: Record<ProblemCode, number> = {
  "intent.unparseable": 400,
  "intent.malformed": 400,
  "intent.denied": 403,
  // 202: the intent was accepted and is waiting on a human, not rejected.
  "approval.pending": 202,
  "enforcement.mismatch": 500,
  "rail.unavailable": 503,
  "principal.unauthorized": 401,
  "operator.unauthorized": 401,
  "operator.refused": 409,
  "memory.denied": 403,
  "memory.forbidden": 403,
  // 202: the write was accepted and is waiting on a human, not rejected.
  "memory.pending": 202,
  // 409: a precondition on current state failed. Nothing was applied.
  "state.stale": 409,
  // 400, not 409: an unparseable token is a defect in the request, not a lost race.
  "state.malformed": 400,
  not_found: 404,
  method_not_allowed: 405,
  unsupported_media_type: 415,
  payload_too_large: 413,
  // 429: the caller may retry after the window, so this is the one refusal that carries a
  // machine-readable backoff instead of a dead end.
  rate_limited: 429,
  quota_exceeded: 429,
  "idempotency.in_flight": 409,
  internal: 500,
};

const ACTIONS: Record<ProblemCode, ErrorAction> = {
  "intent.unparseable": "never-retry",
  "intent.malformed": "never-retry",
  // A policy refusal, not a request defect: rebuilding the intent does not change the
  // mandate that refused it. Only an operator widening policy makes this call succeed.
  "intent.denied": "escalate-to-human",
  // Re-submitting parks it again; the way forward is approval, not retry.
  "approval.pending": "escalate-to-human",
  // The proof did not verify: an integrity incident, never something a client resolves.
  "enforcement.mismatch": "escalate-to-human",
  "rail.unavailable": "retry-as-is",
  "principal.unauthorized": "never-retry",
  "operator.unauthorized": "never-retry",
  // The kernel refused on its own preconditions. A human decides what to do instead.
  "operator.refused": "escalate-to-human",
  "memory.denied": "escalate-to-human",
  // The mandate's scope or capability did not cover the call. Re-negotiate the mandate,
  // then rebuild the request; this is the renegotiation class by definition.
  "memory.forbidden": "retry-after-renegotiation",
  // Re-submitting parks it again; the way forward is operator confirmation, not retry.
  "memory.pending": "escalate-to-human",
  // The one refusal that means exactly "re-read, then send the identical request".
  "state.stale": "retry-as-is",
  // The same bytes always produce the same parse failure, so retrying cannot terminate.
  "state.malformed": "never-retry",
  not_found: "never-retry",
  method_not_allowed: "never-retry",
  unsupported_media_type: "never-retry",
  payload_too_large: "never-retry",
  rate_limited: "retry-as-is",
  // An agent cannot buy itself a bigger plan any more than it can approve its own parked
  // payment: raising the ceiling is an operator act on a separate authority.
  quota_exceeded: "escalate-to-human",
  // Waiting genuinely changes this one: the in-flight attempt terminates and the identical
  // resubmission replays its result. Never retry under a NEW key, which would be a new payment.
  "idempotency.in_flight": "retry-as-is",
  internal: "retry-as-is",
};

/** The action class a code always carries. Codes map to actions; errors never hand-set one. */
export function actionFor(code: ProblemCode): ErrorAction {
  return ACTIONS[code];
}

/** Whether an identical retry could ever succeed. Derived, never hand-set per problem. */
export function isRetryable(p: Problem): boolean {
  return p.action === "retry-as-is";
}

/** Whether the caller must involve a human before doing anything else. */
export function requiresHuman(p: Problem): boolean {
  return p.action === "escalate-to-human";
}

export function nextStep(p: Problem): string {
  return NEXT_STEP[p.action];
}

export function problem(
  code: ProblemCode,
  detail: string,
  extra?: {
    reasons?: string[];
    retryAfter?: number;
    approval?: PendingApproval;
    currentStateToken?: string;
  },
): Problem {
  const action = ACTIONS[code];
  const retryable = action === "retry-as-is";
  return {
    type: PROBLEM_BASE + code,
    title: TITLES[code],
    status: STATUS[code],
    detail,
    code,
    action,
    retryable,
    ...(extra?.reasons ? { reasons: extra.reasons } : {}),
    ...(extra?.approval ? { approval: extra.approval } : {}),
    ...(extra?.currentStateToken ? { currentStateToken: extra.currentStateToken } : {}),
    ...(retryable && extra?.retryAfter !== undefined ? { retryAfter: extra.retryAfter } : {}),
  };
}
