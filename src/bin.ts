#!/usr/bin/env bun
// The stdio entry point. The package was a library only, which meant every MCP
// client's standard launch form (`command` + `args`) could not start it at all:
// there was no bin, no shebang and no transport. `createMcpServer` stays the
// embeddable path for a host that already holds a client; this file is the path
// for the config block a user actually pastes into their agent.
//
// Configuration arrives through the environment because that is what an MCP
// client can set. The signing key never leaves this process: the SDK only ever
// calls sign(bytes).

import { createPrivateKey, createPublicKey, sign as nodeSign } from "node:crypto";
import { createClient, type Signer } from "@general-liquidity/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./index.ts";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX_LEN = 12;

/**
 * An ed25519 signer from a 32-byte hex seed, matching the operator CLI's
 * derivation exactly: GL's agent id IS the public key, so the same seed produces
 * the same identity in both tools.
 */
function signerFromSeed(seedHex: string): Signer {
  const hex = seedHex.startsWith("0x") ? seedHex.slice(2) : seedHex;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "GL_SIGNER_PRIVATE_KEY must be a 32-byte ed25519 seed as 64 hex characters. Value not echoed.",
    );
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(hex, "hex")]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey as unknown as Parameters<typeof createPublicKey>[0]);
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;

  return {
    agentId: spki.subarray(SPKI_ED25519_PREFIX_LEN).toString("hex"),
    sign(bytes: Uint8Array): string {
      return nodeSign(null, Buffer.from(bytes), privateKey).toString("base64");
    },
  };
}

/**
 * Refuses to sign. An agent that only resolves, verifies and discloses never
 * needs a key, and requiring one to start would push operators into putting a
 * signing seed somewhere it is not needed.
 */
const absentSigner: Signer = {
  sign(): never {
    throw new Error(
      "this server was started without GL_SIGNER_PRIVATE_KEY, so it cannot sign a payment",
    );
  },
};

async function main(): Promise<void> {
  const baseUrl = process.env.GL_BASE_URL;
  if (!baseUrl) {
    throw new Error("GL_BASE_URL is required (for example https://sandbox.api.generalliquidity.com/)");
  }

  const seed = process.env.GL_SIGNER_PRIVATE_KEY;
  const client = createClient({
    baseUrl,
    signer: seed ? signerFromSeed(seed) : absentSigner,
  });

  const server = createMcpServer(client, { name: "general-liquidity", version: "0.1.0" });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stderr, never stdout: stdout is the protocol channel and anything written
  // there that is not a message corrupts the session.
  process.stderr.write(`general-liquidity mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
