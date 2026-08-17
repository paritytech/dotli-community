// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach } from "vitest";
import {
  NETWORK_NAME_TO_SERVICES_CONFIG,
  NetworkName,
  getActiveSupportedGenesisHashes,
  getActiveCoreGatewayChains,
  getActiveGatewayChains,
  getActiveGatewaySupportedGenesisHashes,
  setNetworkOverride,
} from "@dotli/config/network";

const v2 = NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO_NEXT_V2];

// Product feature support uses the curated gateway set. The protocol runtime
// accepts a wider operational set because Rust Core also uses Bulletin.
describe("gateway-supported chains (rpc-gateway mode)", () => {
  beforeEach(() => {
    setNetworkOverride(NetworkName.PASEO_NEXT_V2);
  });

  it("As a product, the host advertises relay, Asset Hub, and People", () => {
    const hashes = getActiveGatewaySupportedGenesisHashes();
    expect(hashes.has(v2.relay.genesis.toLowerCase())).toBe(true);
    expect(hashes.has(v2.assethub.genesis.toLowerCase())).toBe(true);
    expect(hashes.has(v2.people.genesis.toLowerCase())).toBe(true);
  });

  it("As a product, the host does not advertise the Bulletin chain", () => {
    const hashes = getActiveGatewaySupportedGenesisHashes();
    expect(hashes.has(v2.bulletin.genesis.toLowerCase())).toBe(false);
  });

  it("As a Rust core runtime, I can access Bulletin through the host gateway set", () => {
    const hashes = new Set(
      getActiveCoreGatewayChains().map((chain) => chain.genesis.toLowerCase()),
    );
    expect(hashes.has(v2.bulletin.genesis.toLowerCase())).toBe(true);
  });

  it("never advertises a chain without a configured RPC endpoint", () => {
    for (const chain of getActiveGatewayChains()) {
      expect(chain.rpcs.length).toBeGreaterThan(0);
    }
  });

  it("stays a subset of the full (smoldot) supported set", () => {
    const full = getActiveSupportedGenesisHashes();
    for (const hash of getActiveGatewaySupportedGenesisHashes()) {
      expect(full.has(hash)).toBe(true);
    }
  });

  it("full smoldot set still includes Bulletin", () => {
    expect(
      getActiveSupportedGenesisHashes().has(v2.bulletin.genesis.toLowerCase()),
    ).toBe(true);
  });
});
