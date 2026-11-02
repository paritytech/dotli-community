// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { CHAIN_ROLE_LABELS, CHAIN_ROLES, NETWORK_NAME_TO_SERVICES_CONFIG } from '@dotli/config';
import { formatHexHeadAndTail } from './formatHexHeadAndTail.js';

const NAME_BY_GENESIS: ReadonlyMap<string, string> = buildRegistry();

/** A chain's network and role name for its genesis hash, or the shortened hash for an unknown chain. Never throws. */
export function formatChainDisplay(genesisHash: string): string {
  const name = getChainName(genesisHash);
  if (name !== null) {
    return name;
  }
  return formatHexHeadAndTail(genesisHash);
}

function getChainName(genesisHash: string): string | null {
  return NAME_BY_GENESIS.get(genesisHash.toLowerCase()) ?? null;
}

/** Every network's chains, so an event from a chain of another network is still named after its own. */
function buildRegistry(): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const config of Object.values(NETWORK_NAME_TO_SERVICES_CONFIG)) {
    for (const role of CHAIN_ROLES) {
      names.set(config[role].genesis.toLowerCase(), `${config.label} ${CHAIN_ROLE_LABELS[role]}`);
    }
  }
  return names;
}
