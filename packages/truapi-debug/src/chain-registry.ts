// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { NETWORK_NAME_TO_SERVICES_CONFIG } from '@dotli/config';

function buildRegistry(): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const cfg of Object.values(NETWORK_NAME_TO_SERVICES_CONFIG)) {
    out.set(cfg.relay.genesis.toLowerCase(), 'Paseo');
    out.set(cfg.assethub.genesis.toLowerCase(), 'Paseo Asset Hub');
    out.set(cfg.bulletin.genesis.toLowerCase(), 'Paseo Bulletin');
    out.set(cfg.people.genesis.toLowerCase(), 'Paseo People');
  }
  return out;
}

const NAME_BY_GENESIS: ReadonlyMap<string, string> = buildRegistry();

export function getChainName(genesisHash: string): string | null {
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
