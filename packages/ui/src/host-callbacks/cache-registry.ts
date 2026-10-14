// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The provider set from the provider registry contract on Asset Hub, for the cache nodes of the experimental setting.
// The host page reads `list()` of the contract through the Asset Hub connection of the host (the protocol frame's light
// client, or the trusted RPC nodes), at the newest finalized block. The last set stays in localStorage. A page that has
// it answers at once and reads the chain in the background, so a read never waits for the light client to sync.

import {
  decodeRegistryList,
  registryCallResult,
  registryListCall,
  registryProviders,
  type CacheProvider,
} from '@dotli/content';
import type { finalizedRuntimeCall } from '@dotli/resolver';
import { log } from '@dotli/shared';
import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';

const REGISTRY_KEY = 'dotli:cache-registry';

/** What the page knows of the registry: the providers of the last read, its block, and the last error. */
export interface RegistryState {
  contract: string;
  providers: CacheProvider[];
  block?: number;
  /** When the page read the chain (ms). Undefined: the set comes from the copy of an earlier page. */
  readAt?: number;
  error?: string;
}

interface SavedSet {
  contract: string;
  block: number;
  providers: CacheProvider[];
}

let state: RegistryState | null = null;

// The resolver brings the chain code, which a page without a registry does not need: one dynamic import for all reads.
let resolver: Promise<{ finalizedRuntimeCall: typeof finalizedRuntimeCall }> | undefined;

/** The last known state of the registry, for the settings. Null before the first read. */
export function registryState(): RegistryState | null {
  return state;
}

function loadSaved(contract: string): SavedSet | null {
  try {
    const saved = JSON.parse(localStorage.getItem(REGISTRY_KEY) ?? 'null') as SavedSet | null;
    return saved?.contract === contract && Array.isArray(saved.providers) ? saved : null;
  } catch {
    return null;
  }
}

function save(set: SavedSet): void {
  try {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(set));
    // eslint-disable-next-line no-restricted-syntax -- without storage, the next page reads the chain first.
  } catch {
    /* ignore */
  }
}

/** Read the registry at `contract` through `provider`: the providers that a host uses, and the block. */
export async function readRegistry(
  provider: JsonRpcProvider,
  contract: string,
): Promise<{ providers: CacheProvider[]; block: number }> {
  resolver ??= import('@dotli/resolver');
  const { finalizedRuntimeCall } = await resolver;
  const { output, block } = await finalizedRuntimeCall(provider, 'ReviveApi_call', registryListCall(contract));
  return { providers: registryProviders(decodeRegistryList(registryCallResult(output))), block: block.number };
}

/**
 * The `loadProviders` of CacheNodes for the registry at `contract`. With a saved set, it answers with that set and
 * reads the chain in the background. Without one, it waits for the chain.
 */
export function registryLoader(
  contract: string,
  provider: () => JsonRpcProvider | Promise<JsonRpcProvider>,
): () => Promise<CacheProvider[]> {
  const saved = loadSaved(contract);
  state = { contract, providers: saved?.providers ?? [], ...(saved ? { block: saved.block } : {}) };
  let reading: Promise<CacheProvider[]> | null = null;
  const read = (): Promise<CacheProvider[]> => {
    reading ??= Promise.resolve(provider())
      .then(chain => readRegistry(chain, contract))
      .then(({ providers, block }) => {
        state = { contract, providers, block, readAt: Date.now() };
        save({ contract, block, providers });
        log.debug(`[cache] registry ${contract}: ${String(providers.length)} providers at block ${String(block)}`);
        return providers;
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        state = { ...(state ?? { contract, providers: [] }), error };
        log.warn(`[cache] the registry ${contract} is unavailable: ${error}`);
        throw err;
      })
      .finally(() => {
        reading = null;
      });
    return reading;
  };
  return () => {
    if (state && state.providers.length > 0) {
      // The set that the page has. The read refreshes it for the next call.
      const current = state.providers;
      read().catch(() => {
        // The state has the error. The page keeps its set.
      });
      return Promise.resolve(current);
    }
    return read();
  };
}
