// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Known-chain name registry
//
// Maps well-known genesis hashes to human-readable names so the
// timeline can label swimlanes and the detail-pane summary can
// describe calls in prose. The registry is built from every network
// in `NETWORK_NAME_TO_SERVICES_CONFIG`, so all genesis hashes across
// all supported testnets resolve regardless of the active network.
//
// The registry is lowercase-keyed so inputs with mixed case (e.g. from
// payloads) resolve without extra normalisation at every call site.

import { NETWORK_NAME_TO_SERVICES_CONFIG } from "@dotli/config/network";

function buildRegistry(): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const cfg of Object.values(NETWORK_NAME_TO_SERVICES_CONFIG)) {
    out.set(cfg.relay.genesis.toLowerCase(), "Paseo");
    out.set(cfg.assethub.genesis.toLowerCase(), "Paseo Asset Hub");
    out.set(cfg.bulletin.genesis.toLowerCase(), "Paseo Bulletin");
    out.set(cfg.people.genesis.toLowerCase(), "Paseo People");
  }
  return out;
}

const NAME_BY_GENESIS: ReadonlyMap<string, string> = buildRegistry();

/**
 * Resolve a human-readable chain name for a given genesis hash.
 * Returns `null` for unknown chains; callers should fall back to
 * rendering a shortened hex form in that case.
 */
export function getChainName(genesisHash: string): string | null {
  return NAME_BY_GENESIS.get(genesisHash.toLowerCase()) ?? null;
}

/**
 * Best-effort display string for a chain: its registered name when
 * known, otherwise a shortened genesis hash (`0x12345678…abcd`).
 */
export function formatChainDisplay(genesisHash: string): string {
  const name = getChainName(genesisHash);
  if (name !== null) {
    return name;
  }
  if (genesisHash.startsWith("0x") && genesisHash.length > 12) {
    return `${genesisHash.slice(0, 8)}…${genesisHash.slice(-4)}`;
  }
  return genesisHash;
}
