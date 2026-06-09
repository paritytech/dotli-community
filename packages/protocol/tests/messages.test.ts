// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  NETWORK_NAME_TO_SERVICES_CONFIG,
  NetworkName,
  getActiveSupportedGenesisHashes,
  setNetwork,
} from "@dotli/config/network";
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

describe("getActiveSupportedGenesisHashes", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("does not contain arbitrary hashes", () => {
    setNetwork(NetworkName.PASEO_NEXT_V1);
    expect(getActiveSupportedGenesisHashes().has("0xdeadbeef")).toBe(false);
  });
});

describe("genesis hash constants", () => {
  it("relay genesis is a 0x-prefixed hex string on every network", () => {
    for (const cfg of Object.values(NETWORK_NAME_TO_SERVICES_CONFIG)) {
      expect(cfg.relay.genesis).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});
