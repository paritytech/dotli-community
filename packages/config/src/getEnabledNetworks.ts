// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { VALID_NETWORKS, isValidNetwork, type Network } from './networkNames.js';
import { readRuntimeNetworkConfig } from './readRuntimeNetworkConfig.js';

/** The raw enabled-network list and the label an error message calls its origin. */
type NetworkSource = {
  /** Names the origin in an error message. */
  label: string;
  /** The unparsed entries, not yet trimmed or checked. */
  entries: readonly string[];
};

/**
 * Networks offered in the selector, from runtime `enabled` when present, else `VITE_NETWORKS`. The first is the
 * default. Throws when the source is unset, names an unknown network, or holds none.
 */
export function getEnabledNetworks(): Network[] {
  const runtimeEnabled = readRuntimeNetworkConfig()?.enabled;
  const source = readNetworkSource(runtimeEnabled);

  if (runtimeEnabled === undefined && source.entries.join('').trim() === '') {
    throw new Error(
      `VITE_NETWORKS is not set, got ${JSON.stringify(source.entries.join(','))}. The deployment must declare a comma-separated list of networks (e.g. "paseo-next-v2,previewnet").`,
    );
  }

  const seen = new Set<Network>();
  const parsed: Network[] = [];
  for (const entry of source.entries) {
    const trimmed = entry.trim();
    if (trimmed === '') {
      continue;
    }
    if (!isValidNetwork(trimmed)) {
      throw new Error(
        `${source.label} contains an unknown network "${trimmed}". Valid values: ${[...VALID_NETWORKS].join(', ')}.`,
      );
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      parsed.push(trimmed);
    }
  }
  if (parsed.length === 0) {
    throw new Error(
      `${source.label} is empty after parsing, got ${JSON.stringify(source.entries)}. Provide at least one valid network.`,
    );
  }
  return parsed;
}

/** The first enabled network, the default. Throws when the enabled networks are unset, unknown or empty. */
export function getDefaultNetwork(): Network {
  const [first] = getEnabledNetworks();
  if (first === undefined) {
    throw new Error('No enabled networks; expected at least one.');
  }
  return first;
}

function readNetworkSource(runtimeEnabled: readonly string[] | undefined): NetworkSource {
  if (runtimeEnabled !== undefined) {
    return { label: "the runtime network config's `enabled`", entries: runtimeEnabled };
  }
  // Node loaders other than Vite's define no `import.meta.env`, which its type says is always there
  const raw = (import.meta as { env?: Partial<ImportMetaEnv> }).env?.VITE_NETWORKS ?? '';
  return { label: 'VITE_NETWORKS', entries: raw.split(',') };
}
