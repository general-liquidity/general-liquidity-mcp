// STALE SDK PIN GUARD.
//
// `@general-liquidity/sdk` is a git dependency pinned by commit hash in bun.lock. A local
// node_modules newer than the lockfile hides a drifted pin, so three separate breakages
// (a missing export, an unknown rail, an absent Decision field) were invisible locally and
// only surfaced in CI. This file is the one obvious place that fails when the installed SDK
// no longer carries what this repo uses: the runtime exports below are asserted at runtime,
// and the type-level block asserts the shapes tsc alone would report as a wall of errors
// scattered across every consuming file.
//
// If this fails: the installed SDK is stale or has changed. Re-resolve the dependency
// (`bun install --force`) and, if it still fails, the SDK's contract has moved and this
// repo must move with it.

import { describe, expect, test } from "bun:test";
import type {
  Commerce,
  Decision,
  Disclosure,
  GeneralLiquidity,
  Intent,
} from "@general-liquidity/sdk";
import * as sdk from "@general-liquidity/sdk";
import { buildTools } from "./tools.ts";

/** Every runtime (non-type) export this server calls into. `bin.ts` builds the client. */
const REQUIRED_RUNTIME_EXPORTS = ["createClient"] as const;

describe("installed @general-liquidity/sdk contract", () => {
  for (const name of REQUIRED_RUNTIME_EXPORTS) {
    test(`exports ${name}`, () => {
      expect(
        typeof (sdk as Record<string, unknown>)[name],
        `@general-liquidity/sdk is missing '${name}'. The pinned SDK is stale — re-resolve the dependency (bun install --force).`,
      ).toBe("function");
    });
  }

  test("the pay tool schema advertises the SDK's rails", () => {
    // Direction checks are compile-time (see tools.ts); this only proves the enum survived
    // into the registered schema instead of collapsing to a bare string.
    const pay = buildTools({} as GeneralLiquidity & Commerce).find((t) => t.name === "pay");
    const intent = pay?.inputSchema.intent as unknown as {
      shape: { terms: { shape: { rail: { options: readonly string[] } } } };
    };
    expect(intent.shape.terms.shape.rail.options).toContain("x402");
  });
});

// Type-level surface. These are the exact shapes past CI breakages turned on; a change to
// any of them fails compilation HERE, naming the field, rather than downstream.
type _RequiresClientSurface = Pick<GeneralLiquidity, "resolve" | "pay" | "verify" | "disclose">;
type _RequiresDecisionChecks = NonNullable<Decision["checks"]>[number]["id"];
type _RequiresIntentTerms = Intent["terms"]["rail"];
type _RequiresDisclosureSignature = Disclosure["signature"]["publicKey"];
type _RequiresSigner = sdk.Signer;
