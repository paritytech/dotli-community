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
  ENVELOPE_CHAIN_KEYS,
  ENVELOPE_SYNC_KINDS,
  isChainSyncPayloadValid,
  isProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolResponseEnvelope,
  type ProtocolErrorEnvelope,
  type ProtocolProgressEnvelope,
  type ProtocolChainMessageEnvelope,
  type ProtocolChainHaltEnvelope,
  type ProtocolReadyEnvelope,
  type ProtocolChainSyncEnvelope,
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

describe("chain-sync envelope validation works", () => {
  function envelope(
    over: Partial<ProtocolChainSyncEnvelope> = {},
  ): ProtocolChainSyncEnvelope {
    return {
      namespace: "dotli:protocol",
      kind: "chain-sync",
      chain: "relay",
      syncKind: "firstPeer",
      ...over,
    };
  }

  // This is the drift guard. The resolver owns the vocabulary, and the
  // validator keeps its own runtime copy so smoldot stays out of every
  // bundle that talks to the protocol. When the two fell out of step, three
  // kinds were dropped in silence and the loading screen simply went quiet.
  it("As a user, every sync milestone the resolver can emit reaches the shell", () => {
    // Given / When / Then
    for (const chain of ENVELOPE_CHAIN_KEYS) {
      for (const syncKind of ENVELOPE_SYNC_KINDS) {
        expect(
          isChainSyncPayloadValid(
            envelope({
              chain,
              syncKind,
              ...(syncKind === "peers" ? { peers: 1 } : {}),
            }),
          ),
        ).toBe(true);
      }
    }
  });

  it("As a user, a spoofed chain or milestone is refused", () => {
    // Given / When / Then
    expect(
      isChainSyncPayloadValid(
        envelope({
          chain: "not-a-chain" as (typeof ENVELOPE_CHAIN_KEYS)[number],
        }),
      ),
    ).toBe(false);
    expect(
      isChainSyncPayloadValid(
        envelope({
          syncKind: "somethingElse" as (typeof ENVELOPE_SYNC_KINDS)[number],
        }),
      ),
    ).toBe(false);
  });

  it("As a user, a nonsense peer count or block height is refused", () => {
    // Given / When / Then
    for (const peers of [-1, 1.5, 10_001, Number.NaN]) {
      expect(
        isChainSyncPayloadValid(envelope({ syncKind: "peers", peers })),
      ).toBe(false);
    }
    expect(
      isChainSyncPayloadValid(
        envelope({ syncKind: "warpSyncProgress", at: Number.NaN, target: 10 }),
      ),
    ).toBe(false);
    expect(
      isChainSyncPayloadValid(
        envelope({ syncKind: "warpSyncFinished", finalized: -5 }),
      ),
    ).toBe(false);
  });
});
