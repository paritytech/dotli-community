// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { CHAIN_ROLE_LABELS, CHAIN_ROLES, NETWORK_NAME_TO_SERVICES_CONFIG } from '@dotli/config';

/** Every network's chains, so an event from a chain of another network is still named after its own. */
function buildRegistry(): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const cfg of Object.values(NETWORK_NAME_TO_SERVICES_CONFIG)) {
    for (const role of CHAIN_ROLES) {
      out.set(cfg[role].genesis.toLowerCase(), `${cfg.label} ${CHAIN_ROLE_LABELS[role]}`);
    }
  }
  return out;
}

const NAME_BY_GENESIS: ReadonlyMap<string, string> = buildRegistry();

function getChainName(genesisHash: string): string | null {
  return NAME_BY_GENESIS.get(genesisHash.toLowerCase()) ?? null;
}

export function formatChainDisplay(genesisHash: string): string {
  const name = getChainName(genesisHash);
  if (name !== null) {
    return name;
  }
  if (genesisHash.startsWith('0x') && genesisHash.length > 12) {
    return `${genesisHash.slice(0, 8)}…${genesisHash.slice(-4)}`;
  }
  return genesisHash;
}
