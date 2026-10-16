// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The cache nodes of the experimental setting (Settings, Experimental, Cache nodes). The preimage adapters read through
// them before Bulletin, and log each read to the debug panel.

import { getCacheNodeSettings } from '@dotli/config';
import { CacheNodes, testPayerSeed, type CacheRead } from '@dotli/content';

import { registryLoader } from './cache-registry.js';

// The Asset Hub connection of the host page. A dynamic import keeps the chain pool out of the modules that only read.
async function assetHub(): Promise<JsonRpcProvider> {
  return (await import('./Chain.js')).hostAssetHubProvider();
}
import { emitDotliDebugEvent } from '@dotli/truapi-debug';
import { fromHex, log } from '@dotli/shared';
import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';

const SEED_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;

// The cache nodes of the setting, one instance for each payer. They all read the same provider set and quality store.
const instances = new Map<string, CacheNodes>();
let settingsKey = '';

/**
 * The cache nodes of the setting, or null when the setting is off or has no source of providers. The provider registry
 * on Asset Hub is the source when the setting names one, else the provider set URL. With `payerSeed` (the cache payer
 * of a product for the signed-in person), they pay with that payer; else with the payer seed of the setting, or the
 * shared test payer `dotli`.
 */
export function getCacheNodes(payerSeed?: Uint8Array): CacheNodes | null {
  const settings = getCacheNodeSettings();
  if (!settings.enabled || (settings.registry === '' && settings.providersUrl === '')) {
    return null;
  }
  const key = JSON.stringify(settings);
  if (key !== settingsKey) {
    instances.clear();
    settingsKey = key;
  }
  const seed =
    payerSeed?.length === 32
      ? payerSeed
      : SEED_PATTERN.test(settings.payerSeed)
        ? fromHex(settings.payerSeed)
        : testPayerSeed('dotli');
  const seedKey = Array.from(seed, byte => byte.toString(16).padStart(2, '0')).join('');
  let nodes = instances.get(seedKey);
  if (nodes === undefined) {
    const source =
      settings.registry !== ''
        ? { loadProviders: registryLoader(settings.registry, assetHub) }
        : { providersUrl: settings.providersUrl };
    nodes = new CacheNodes({ ...source, payerSeed: seed });
    instances.set(seedKey, nodes);
    const from = settings.registry !== '' ? `the registry ${settings.registry}` : settings.providersUrl;
    log.debug(`[cache] reading through cache nodes of ${from}, payer ${nodes.payer.id}`);
  }
  return nodes;
}

/** The name of a cache node for people: its name, else its API URL. */
function nodeName(provider: { name?: string; api: string }): string {
  return provider.name ?? provider.api;
}

/** Log one read through cache nodes, and show it in the debug panel. */
export function reportCacheRead(key: string, cid: string, read: CacheRead, latencyMs: number): void {
  const served = read.served;
  const origin =
    served === undefined ? undefined : served.origin.kind === 'peer' ? `peer:${served.origin.id}` : served.origin.kind;
  emitDotliDebugEvent({
    layer: 'preimage',
    event: 'cache_read',
    flowId: `cache-read-${key}-${String(Date.now())}`,
    timestamp: Date.now(),
    payload: {
      key,
      cid,
      outcome: served === undefined ? 'missed' : 'served',
      ...(served === undefined || origin === undefined
        ? {}
        : { node: nodeName(served.provider), origin, rank: served.rank, home: served.home }),
      latencyMs,
      attempts: read.attempts.map(attempt => `${nodeName(attempt.provider)}: ${attempt.outcome}`),
    },
  });
  if (served === undefined) {
    log.debug(`[cache] no cache node had ${cid}: ${read.attempts.map(a => a.outcome).join(', ') || 'no providers'}`);
  } else {
    log.debug(
      `[cache] ${nodeName(served.provider)} served ${cid} (origin ${origin ?? '?'}) in ${String(latencyMs)} ms`,
    );
  }
}

/**
 * One block of a site (or of any DAG on Bulletin) through the cache nodes of the setting, checked against its CID: the
 * bytes, or null when the setting is off or no cache node had the block. The site loader asks it before bitswap, so a
 * site that a cache node keeps loads from that node.
 */
export async function readSiteBlock(cid: string): Promise<Uint8Array | null> {
  const cache = getCacheNodes();
  if (cache === null) {
    return null;
  }
  const started = Date.now();
  const read = await cache.readBlock(cid);
  reportCacheRead(cid, cid, read, Date.now() - started);
  return read.value ?? null;
}
