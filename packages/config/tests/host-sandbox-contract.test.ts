// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import {
  SANDBOX_SCHEMA_VERSION,
  SANDBOX_CONTRACT_PARAMS,
  validateSandboxParams,
} from "@dotli/config/host-sandbox-contract";
import { NetworkName } from "@dotli/config/network";

const VALID_CID = "bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

/** Build a search string with the required v3 params, allowing overrides. */
function search(
  overrides: Record<string, string | null> = {},
): URLSearchParams {
  const base: Record<string, string> = {
    [SANDBOX_CONTRACT_PARAMS.cid]: VALID_CID,
    [SANDBOX_CONTRACT_PARAMS.chainBackend]: "smoldot-direct",
    [SANDBOX_CONTRACT_PARAMS.network]: NetworkName.PASEO,
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
      expect(result.params.network).toBe(NetworkName.PASEO);
    }
  });

  it("As the sandbox, I reject a contract that omits the cid, but flag it recoverable so the host can re-render me", () => {
    // Given a contract with no cid param (the post-boot strip leaves
    // exactly this shape behind, so a reload of a booted sandbox lands here).
    const params = search({ [SANDBOX_CONTRACT_PARAMS.cid]: null });

    // When the sandbox validates it.
    const result = validateSandboxParams(params);

    // Then it fails with a reason that names the missing key, and marks
    // the failure recoverable so the boot path asks the host for a fresh
    // contract URL instead of dying on a dead-end error page.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/cid/i);
      expect(result.recoverable).toBe(true);
    }
  });

  it("As the sandbox, I reject a contract whose cid is the empty string as fatal, since the host explicitly sent a broken value", () => {
    // Given a contract with an empty cid.
    const params = search({ [SANDBOX_CONTRACT_PARAMS.cid]: "" });

    // When the sandbox validates it.
    const result = validateSandboxParams(params);

    // Then it fails, and is NOT recoverable: an empty value cannot come
    // from the post-boot param strip, so re-rendering from the same host
    // would produce the same empty cid again.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.recoverable).not.toBe(true);
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

  it("As a user whose dApp reloads itself after the param strip, the contract failure is recoverable so the host can restore my session", () => {
    // Given a URL with no contract params at all, which is what a booted
    // sandbox window looks like after stripContractParamsFromUrl: a dApp
    // calling location.reload() re-enters the boot with this exact shape.
    const params = new URLSearchParams({ theme: "dark" });

    // When the sandbox validates it.
    const result = validateSandboxParams(params);

    // Then the failure is recoverable: the host still tracks the rendered
    // label and CID, so it can rebuild the iframe instead of stranding the
    // user on a full-viewport "Invalid sandbox URL" error.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.recoverable).toBe(true);
  });
});

describe("validateSandboxParams: resolution id", () => {
  it("As the sandbox, I read the resolution id the host threaded through", () => {
    // Given a contract carrying the host's correlation id.
    const params = search({
      [SANDBOX_CONTRACT_PARAMS.resolutionId]:
        "f1e2d3c4-b5a6-4778-8899-aabbccddeeff",
    });

    // When the sandbox validates it.
    const result = validateSandboxParams(params);

    // Then the id reaches the caller so it can tag its own telemetry.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params.resolutionId).toBe(
        "f1e2d3c4-b5a6-4778-8899-aabbccddeeff",
      );
    }
  });

  it("As the sandbox, I boot normally for a host build that sends no resolution id", () => {
    // Given a contract from a host that predates the correlation id.
    const params = search();

    // When the sandbox validates it.
    const result = validateSandboxParams(params);

    // Then the boot succeeds and the id is simply absent. A trace id must
    // never be the reason a product fails to load.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params.resolutionId).toBeNull();
    }
  });

  it("As the sandbox, I drop a malformed resolution id rather than refuse to boot", () => {
    // Given an id carrying characters the contract does not accept.
    const params = search({
      [SANDBOX_CONTRACT_PARAMS.resolutionId]: "../../etc/passwd",
    });

    // When the sandbox validates it.
    const result = validateSandboxParams(params);

    // Then the contract still validates, untagged.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params.resolutionId).toBeNull();
    }
  });

  it("As the sandbox, I drop an over-long resolution id", () => {
    // Given an id past the length the contract bounds it to.
    const params = search({
      [SANDBOX_CONTRACT_PARAMS.resolutionId]: "a".repeat(65),
    });

    // When the sandbox validates it.
    const result = validateSandboxParams(params);

    // Then it is ignored rather than carried into telemetry.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params.resolutionId).toBeNull();
    }
  });

  it("As a dApp, the resolution id is stripped from my URL with the rest of the contract", () => {
    // Given the strip iterates the contract param map.
    const keys = Object.values(SANDBOX_CONTRACT_PARAMS);

    // Then the id is in that map, so `stripContractParamsFromUrl` removes it
    // and it never leaks into the product's own `location.search`.
    expect(keys).toContain(SANDBOX_CONTRACT_PARAMS.resolutionId);
  });
});
