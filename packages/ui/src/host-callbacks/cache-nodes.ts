// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The cache nodes of the experimental setting (Settings, Experimental, Cache nodes). The preimage adapters read through
// them before Bulletin, and log each read to the debug panel.

import { getCacheNodeSettings } from '@dotli/config';
import { CacheNodes, testPayerSeed, type CacheRead } from '@dotli/content';
import { emitDotliDebugEvent } from '@dotli/truapi-debug';
import { fromHex, log } from '@dotli/shared';

const SEED_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;

let current: { settings: string; nodes: CacheNodes } | null = null;

/** The cache nodes of the setting, or null when the setting is off or has no provider set URL. */
export function getCacheNodes(): CacheNodes | null {
  const settings = getCacheNodeSettings();
  if (!settings.enabled || settings.providersUrl === '') {
    return null;
  }
  const key = JSON.stringify(settings);
  if (current?.settings !== key) {
    const seed = SEED_PATTERN.test(settings.payerSeed) ? fromHex(settings.payerSeed) : testPayerSeed('dotli');
    current = { settings: key, nodes: new CacheNodes({ providersUrl: settings.providersUrl, payerSeed: seed }) };
    log.debug(`[cache] reading through cache nodes of ${settings.providersUrl}, payer ${current.nodes.payer.id}`);
  }
  return current.nodes;
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
