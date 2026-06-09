// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import {
  SANDBOX_SCHEMA_VERSION,
  SANDBOX_CONTRACT_PARAMS,
  validateSandboxParams,
} from "@dotli/config/host-sandbox-contract";

const VALID_CID = "bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

/** Build a search string with the required v3 params, allowing overrides. */
function search(
  overrides: Record<string, string | null> = {},
): URLSearchParams {
  const base: Record<string, string> = {
    [SANDBOX_CONTRACT_PARAMS.cid]: VALID_CID,
    [SANDBOX_CONTRACT_PARAMS.chainBackend]: "smoldot-direct",
    [SANDBOX_CONTRACT_PARAMS.network]: "paseo-next-v2",
  };
  const params = new URLSearchParams(base);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  return params;
}

describe("validateSandboxParams: v3 cid contract", () => {
  it("As the sandbox, when I receive a valid contract, I read cid, chainBackend, and network from the params", () => {
    // Given a contract that carries every required v3 param.
    const params = search();

    // When the sandbox validates it.
    const result = validateSandboxParams(params);

    // Then the validator surfaces every required value back to the caller.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params.cid).toBe(VALID_CID);
      expect(result.params.chainBackend).toBe("smoldot-direct");
      expect(result.params.network).toBe("paseo-next-v2");
    }
  });

  it("As the sandbox, I reject a contract that omits the cid", () => {
    // Given a contract with no cid param.
    const params = search({ [SANDBOX_CONTRACT_PARAMS.cid]: null });

    // When the sandbox validates it.
    const result = validateSandboxParams(params);

    // Then it fails with a reason that names the missing key.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/cid/i);
  });

  it("As the sandbox, I reject a contract whose cid is the empty string", () => {
    // Given a contract with an empty cid.
    const params = search({ [SANDBOX_CONTRACT_PARAMS.cid]: "" });

    // When the sandbox validates it.
    const result = validateSandboxParams(params);

    // Then it fails (an empty cid is treated the same as a missing one).
    expect(result.ok).toBe(false);
  });

  it("As the sandbox, I reject a contract whose cid contains non-alphanumeric characters", () => {
    // Given a contract that smuggles a path-traversal string in `cid`.
    const params = search({
      [SANDBOX_CONTRACT_PARAMS.cid]: "../etc/passwd",
    });

    // When the sandbox validates it.
    const result = validateSandboxParams(params);

    // Then the charset gate trips before the value reaches any downstream parser.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/invalid cid/i);
  });

  it("As the sandbox, I accept a contract whose schema version matches my build", () => {
    // Given a contract that pins the current schema version.
    const params = search({
      [SANDBOX_CONTRACT_PARAMS.v]: String(SANDBOX_SCHEMA_VERSION),
    });

    // When the sandbox validates it.
    const result = validateSandboxParams(params);

    // Then it passes.
    expect(result.ok).toBe(true);
  });

  it("As the sandbox, I reject a contract whose schema version is older than my build", () => {
    // Given a contract from a host built against an older schema.
    const params = search({
      [SANDBOX_CONTRACT_PARAMS.v]: String(SANDBOX_SCHEMA_VERSION - 1),
    });

    // When the sandbox validates it.
    const result = validateSandboxParams(params);

    // Then it fails (the version gate protects against stale host deploys).
    expect(result.ok).toBe(false);
  });

  it("As the sandbox, I reject a contract that omits the chainBackend", () => {
    // Given a contract with no chainBackend param.
    const params = search({ [SANDBOX_CONTRACT_PARAMS.chainBackend]: null });

    // When the sandbox validates it.
    const result = validateSandboxParams(params);

    // Then it fails (chainBackend is still required after the v3 bump).
    expect(result.ok).toBe(false);
  });

  it("As the sandbox, I reject a contract that omits the network", () => {
    // Given a contract with no network param.
    const params = search({ [SANDBOX_CONTRACT_PARAMS.network]: null });

    // When the sandbox validates it.
    const result = validateSandboxParams(params);

    // Then it fails (network is still required after the v3 bump).
    expect(result.ok).toBe(false);
  });
});
