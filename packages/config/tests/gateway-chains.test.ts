// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach } from "vitest";
import {
  NETWORK_NAME_TO_SERVICES_CONFIG,
  NetworkName,
  getActiveSupportedGenesisHashes,
  getActiveGatewayChains,
  getActiveGatewaySupportedGenesisHashes,
  setNetworkOverride,
} from "@dotli/config/network";

const v2 = NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO_NEXT_V2];

// The gateway set drives the host's chain-support advertisement in
// rpc-gateway mode (`isRemoteChainSupported`). It must match what the gateway
// backend can actually serve (`createRpcChainProvider`), or a dApp commits to
// a connection that never completes.
describe("gateway-supported chains (rpc-gateway mode)", () => {
  beforeEach(() => {
    setNetworkOverride(NetworkName.PASEO_NEXT_V2);
  });

  it("serves relay, Asset Hub, and People", () => {
    const hashes = getActiveGatewaySupportedGenesisHashes();
    expect(hashes.has(v2.relay.genesis.toLowerCase())).toBe(true);
    expect(hashes.has(v2.assethub.genesis.toLowerCase())).toBe(true);
    expect(hashes.has(v2.people.genesis.toLowerCase())).toBe(true);
  });

  it("excludes the Bulletin chain (content served via IPFS, not chain RPC)", () => {
    const hashes = getActiveGatewaySupportedGenesisHashes();
    expect(hashes.has(v2.bulletin.genesis.toLowerCase())).toBe(false);
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
