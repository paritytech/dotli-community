import { describe, it, expect } from "vitest";
import {
  SUPPORTED_GENESIS_HASHES,
  PASEO_RELAY_GENESIS,
  ASSET_HUB_PASEO_GENESIS,
  BULLETIN_PASEO_GENESIS,
  PEOPLE_PASEO_GENESIS,
} from "@dotli/config/config";
import {
  isProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolResponseEnvelope,
  type ProtocolErrorEnvelope,
  type ProtocolProgressEnvelope,
  type ProtocolChainMessageEnvelope,
  type ProtocolChainHaltEnvelope,
  type ProtocolReadyEnvelope,
} from "@dotli/protocol/messages";

describe("isProtocolEnvelope", () => {
  it("returns true for a valid request envelope", () => {
    const envelope: ProtocolRequestEnvelope = {
      namespace: "dotli:protocol",
      kind: "request",
      id: "test-1",
      method: "warmup",
      payload: {} as Record<string, never>,
    };
    expect(isProtocolEnvelope(envelope)).toBe(true);
  });

  it("returns true for a valid response envelope", () => {
    const envelope: ProtocolResponseEnvelope = {
      namespace: "dotli:protocol",
      kind: "response",
      id: "test-1",
      ok: true,
      result: "some-cid",
    };
    expect(isProtocolEnvelope(envelope)).toBe(true);
  });

  it("returns true for a valid error envelope", () => {
    const envelope: ProtocolErrorEnvelope = {
      namespace: "dotli:protocol",
      kind: "response",
      id: "test-1",
      ok: false,
      error: "something failed",
    };
    expect(isProtocolEnvelope(envelope)).toBe(true);
  });

  it("returns true for a valid progress envelope", () => {
    const envelope: ProtocolProgressEnvelope = {
      namespace: "dotli:protocol",
      kind: "progress",
      id: "test-1",
      message: "Connecting to relay chain...",
    };
    expect(isProtocolEnvelope(envelope)).toBe(true);
  });

  it("returns true for a valid chain-message envelope", () => {
    const envelope: ProtocolChainMessageEnvelope = {
      namespace: "dotli:protocol",
      kind: "chain-message",
      connectionId: "conn-1",
      message: '{"jsonrpc":"2.0"}',
    };
    expect(isProtocolEnvelope(envelope)).toBe(true);
  });

  it("returns true for a valid chain-halt envelope", () => {
    const envelope: ProtocolChainHaltEnvelope = {
      namespace: "dotli:protocol",
      kind: "chain-halt",
      connectionId: "conn-1",
    };
    expect(isProtocolEnvelope(envelope)).toBe(true);
  });

  it("returns true for a valid ready envelope", () => {
    const envelope: ProtocolReadyEnvelope = {
      namespace: "dotli:protocol",
      kind: "ready",
    };
    expect(isProtocolEnvelope(envelope)).toBe(true);
  });

  it("returns false for null", () => {
    expect(isProtocolEnvelope(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isProtocolEnvelope(undefined)).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isProtocolEnvelope("dotli:protocol")).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isProtocolEnvelope(42)).toBe(false);
  });

  it("returns false for an empty object", () => {
    expect(isProtocolEnvelope({})).toBe(false);
  });

  it("returns false for wrong namespace", () => {
    expect(
      isProtocolEnvelope({ namespace: "other:protocol", kind: "request" }),
    ).toBe(false);
  });

  it("returns false for missing kind", () => {
    expect(isProtocolEnvelope({ namespace: "dotli:protocol" })).toBe(false);
  });

  it("returns false for unknown kind", () => {
    expect(
      isProtocolEnvelope({ namespace: "dotli:protocol", kind: "unknown" }),
    ).toBe(false);
  });

  it("returns false for missing namespace", () => {
    expect(isProtocolEnvelope({ kind: "request" })).toBe(false);
  });
});

describe("SUPPORTED_GENESIS_HASHES", () => {
  it("contains the Paseo relay genesis hash", () => {
    expect(SUPPORTED_GENESIS_HASHES.has(PASEO_RELAY_GENESIS)).toBe(true);
  });

  it("contains the Asset Hub Paseo genesis hash", () => {
    expect(SUPPORTED_GENESIS_HASHES.has(ASSET_HUB_PASEO_GENESIS)).toBe(true);
  });

  it("contains the Bulletin Paseo genesis hash", () => {
    expect(SUPPORTED_GENESIS_HASHES.has(BULLETIN_PASEO_GENESIS)).toBe(true);
  });

  it("contains the People Paseo genesis hash", () => {
    expect(SUPPORTED_GENESIS_HASHES.has(PEOPLE_PASEO_GENESIS)).toBe(true);
  });

  it("does not contain arbitrary hashes", () => {
    expect(SUPPORTED_GENESIS_HASHES.has("0xdeadbeef")).toBe(false);
  });

  it("has exactly 4 supported chains", () => {
    expect(SUPPORTED_GENESIS_HASHES.size).toBe(4);
  });
});

describe("genesis hash constants", () => {
  it("PASEO_RELAY is a 0x-prefixed hex string", () => {
    expect(PASEO_RELAY_GENESIS).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("ASSET_HUB_PASEO is a 0x-prefixed hex string", () => {
    expect(ASSET_HUB_PASEO_GENESIS).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("PASEO_RELAY and ASSET_HUB_PASEO are different", () => {
    expect(PASEO_RELAY_GENESIS).not.toBe(ASSET_HUB_PASEO_GENESIS);
  });
});
