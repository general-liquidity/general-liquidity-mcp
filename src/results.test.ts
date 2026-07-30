// The structured-failure contract. These assert the two things an agent actually branches
// on — the stable `code` and the closed `action` class — survive every shape a failure can
// arrive in: a modern problem body, a bare problem `type` URI, one of the SDK's own legacy
// slugs, an SDK error class with no body at all, and something entirely unrecognized.

import { describe, expect, test } from "bun:test";
import { ALL_PROBLEM_CODES, actionFor, nextStep, problem } from "./problem.ts";
import { failFromThrown, failWith, ok } from "./results.ts";

interface ThrownShape {
  name?: string;
  type?: string;
  retryAfterMs?: number;
  problem?: Record<string, unknown>;
}

/** Stands in for a thrown `GlError`: same fields, without importing the SDK's classes. */
function thrown(message: string, extra: ThrownShape = {}): Error {
  const err = new Error(message);
  if (extra.name) err.name = extra.name;
  return Object.assign(err, extra);
}

function structured(res: ReturnType<typeof failFromThrown>) {
  return res.structuredContent as unknown as {
    code: string;
    message: string;
    action: string;
    data: Record<string, unknown>;
  };
}

describe("success results", () => {
  test("ok carries the value untouched and is not an error", () => {
    const res = ok({ reference: "0xabc" });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({ result: { reference: "0xabc" } });
    expect(res.content[0]!.text).toBe('{"reference":"0xabc"}');
  });
});

describe("a problem body from the wire", () => {
  test("a refusal keeps its code, action class and reasons", () => {
    const res = failFromThrown(
      thrown("denied", {
        name: "DeniedError",
        type: "intent.denied",
        problem: {
          type: "https://docs.generalliquidity.com/problems/intent.denied",
          code: "intent.denied",
          detail: "The gate denied intent idem-1.",
          reasons: ["payee not on the mandate"],
        },
      }),
    );
    const s = structured(res);
    expect(res.isError).toBe(true);
    expect(s.code).toBe("intent.denied");
    expect(s.message).toBe("The gate denied intent idem-1.");
    expect(s.action).toBe("escalate-to-human");
    expect(s.data["retryable"]).toBe(false);
    expect(s.data["status"]).toBe(403);
    expect(s.data["reasons"]).toEqual(["payee not on the mandate"]);
    expect(s.data["nextStep"]).toBe("Stop. A human operator must decide; no retry helps.");
    // Text content is what a text-only host renders; the refusal has to survive there too.
    expect(res.content[0]!.text).toContain("denied");
  });

  test("a parked intent carries the id and challenge an operator needs to release it", () => {
    const res = failFromThrown(
      thrown("parked", {
        name: "ApprovalPendingError",
        problem: {
          code: "approval.pending",
          detail: "Intent idem-1 is parked pending operator approval.",
          reasons: ["velocity: 4 payments in 10 minutes"],
          approval: { intentId: "idem-1", challenge: "chal-9f2", mandateId: "m1" },
        },
      }),
    );
    const s = structured(res);
    expect(s.code).toBe("approval.pending");
    expect(s.action).toBe("escalate-to-human");
    expect(s.data["status"]).toBe(202);
    expect(s.data["approval"]).toEqual({
      intentId: "idem-1",
      challenge: "chal-9f2",
      mandateId: "m1",
    });
    expect(s.data["reasons"]).toEqual(["velocity: 4 payments in 10 minutes"]);
    expect(res.content[0]!.text).toContain("idem-1");
    // This surface has no approve verb, and the hint must not imply one.
    expect(res.content[0]!.text).toContain("cannot approve it");
  });

  test("a rate limit is retryable and carries a backoff in seconds", () => {
    const res = failFromThrown(
      thrown("slow down", {
        name: "RateLimitError",
        retryAfterMs: 2500,
        problem: { code: "rate_limited", detail: "Rate limit exceeded." },
      }),
    );
    const s = structured(res);
    expect(s.code).toBe("rate_limited");
    expect(s.action).toBe("retry-as-is");
    expect(s.data["retryable"]).toBe(true);
    // The SDK decodes Retry-After into ms; the problem body carries seconds.
    expect(s.data["retryAfter"]).toBe(3);
  });

  test("a stale state token comes back with the token the peer actually holds", () => {
    const res = failFromThrown(
      thrown("state moved", {
        problem: {
          type: "https://docs.generalliquidity.com/problems/state.stale",
          detail: "State moved under the caller.",
          currentStateToken: "st-42",
        },
      }),
    );
    const s = structured(res);
    // No `code` member on this body: the code came from the type URI's trailing segment.
    expect(s.code).toBe("state.stale");
    expect(s.action).toBe("retry-as-is");
    expect(s.data["currentStateToken"]).toBe("st-42");
  });

  test("a memory mandate refusal is the renegotiation class, not a dead end", () => {
    const res = failFromThrown(
      thrown("forbidden", {
        problem: { code: "memory.forbidden", detail: "Recall reached before the as-of floor." },
      }),
    );
    const s = structured(res);
    expect(s.code).toBe("memory.forbidden");
    expect(s.action).toBe("retry-after-renegotiation");
    expect(s.data["retryable"]).toBe(false);
  });
});

describe("the SDK's legacy slugs bridged onto the shared taxonomy", () => {
  const cases: Array<[string, string, string]> = [
    ["denied", "intent.denied", "escalate-to-human"],
    ["mandate-exceeded", "intent.denied", "escalate-to-human"],
    ["insufficient-funds", "intent.denied", "escalate-to-human"],
    ["validation", "intent.malformed", "never-retry"],
    ["idempotency-conflict", "intent.malformed", "never-retry"],
    ["unauthorized", "principal.unauthorized", "never-retry"],
    ["forbidden", "principal.unauthorized", "never-retry"],
    ["rate-limited", "rate_limited", "retry-as-is"],
    ["not-found", "not_found", "never-retry"],
    ["approval-pending", "approval.pending", "escalate-to-human"],
  ];

  for (const [slug, code, action] of cases) {
    test(`${slug} → ${code}`, () => {
      const s = structured(failFromThrown(thrown("failed", { type: slug })));
      expect(s.code).toBe(code);
      expect(s.action).toBe(action);
    });
  }

  test("a held clearing band is retry-as-is, never confused with a parked approval", () => {
    const s = structured(failFromThrown(thrown("held", { type: "clearing.pending" })));
    // Nothing here waits on a human: the hold auto-releases once evidence is admissible.
    expect(s.code).toBe("rail.unavailable");
    expect(s.action).toBe("retry-as-is");
    expect(s.code).not.toBe("approval.pending");
  });
});

describe("failures with no code at all", () => {
  test("an SDK error class alone still resolves an action class", () => {
    const s = structured(
      failFromThrown(thrown("mandate exceeded", { name: "MandateExceededError" })),
    );
    expect(s.code).toBe("intent.denied");
    expect(s.message).toBe("mandate exceeded");
  });

  test("an unrecognized failure degrades to internal without losing the message", () => {
    const s = structured(failFromThrown(new Error("socket hang up")));
    expect(s.code).toBe("internal");
    expect(s.message).toBe("socket hang up");
    expect(s.action).toBe("retry-as-is");
  });

  test("a thrown non-Error still produces a problem", () => {
    const s = structured(failFromThrown("everything is fine"));
    expect(s.code).toBe("internal");
    expect(s.message).toBe("everything is fine");
  });

  test("an unknown slug is not silently accepted as a code", () => {
    const s = structured(failFromThrown(thrown("what", { type: "teapot" })));
    expect(s.code).toBe("internal");
  });
});

describe("the taxonomy itself", () => {
  test("every code produces a next step and a retryable derived from its action", () => {
    for (const code of ALL_PROBLEM_CODES) {
      const p = problem(code, "detail");
      expect(p.code).toBe(code);
      expect(p.action).toBe(actionFor(code));
      expect(p.retryable).toBe(p.action === "retry-as-is");
      expect(nextStep(p).length).toBeGreaterThan(0);
    }
  });

  test("a backoff is dropped on a code no retry can resolve", () => {
    const s = structured(failWith("intent.denied", "denied", { retryAfter: 30 }));
    expect(s.data["retryAfter"]).toBeUndefined();
    expect(
      structured(failWith("rate_limited", "slow", { retryAfter: 30 })).data["retryAfter"],
    ).toBe(30);
  });
});
