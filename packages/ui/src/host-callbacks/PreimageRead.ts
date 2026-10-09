// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// `Preimage.read`: one read of a preimage through a route that the product chooses, with a report of every source that
// the host asked. Products that show or measure the cache use it (the demo product cache-demo.paseo). There are four
// routes. `Auto` is the host's normal order: cache nodes when the setting is on, then Bulletin. The other routes are
// Bulletin only, cache nodes only, and one cache node. With `skipHostCaches` the page's own preimage cache does not
// answer, so the read measures the network.

import type { PreimageReadHost } from '@parity/truapi-host';
import type {
  CacheOrigin,
  PreimageReadAttempt,
  PreimageReadOutcome,
  PreimageReadRoute,
  PreimageReadSource,
  RemotePreimageReadResponse,
} from '@parity/truapi';
import { blake2b } from '@noble/hashes/blake2.js';
import { getBackend } from '@dotli/config';
import { bitswapGet, fetchFromIpfs, hashToCid, type CacheOrigin as NodeOrigin, type CacheRead } from '@dotli/content';
import { serializeError, toHex } from '@dotli/shared';

import { getCacheNodes, reportCacheRead } from './cache-nodes.js';
import { cachedPreimage, rememberPreimage } from './Preimage.js';

const BULLETIN_TIMEOUT_MS = 60_000;

type HexString = `0x${string}`;

const hex = (bytes: Uint8Array): HexString => toHex(bytes);
const prefixed = (id: string): HexString => (id.startsWith('0x') ? id : `0x${id}`) as HexString;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function origin(from: NodeOrigin): CacheOrigin {
  switch (from.kind) {
    case 'local':
      return { tag: 'Local' };
    case 'source':
      return { tag: 'Source' };
    case 'peer':
      return { tag: 'Peer', value: { id: prefixed(from.id) } };
    case 'unknown':
      return { tag: 'Unknown' };
  }
}

function outcome(from: CacheRead['attempts'][number]): PreimageReadOutcome {
  switch (from.outcome) {
    case 'served':
      return { tag: 'Served' };
    case 'miss':
      return { tag: 'Miss' };
    case 'bad-bytes':
      return { tag: 'BadBytes' };
    case 'refused':
      return { tag: 'Refused', value: { reason: from.reason ?? '' } };
    case 'failed':
      return { tag: 'Failed', value: { reason: from.reason ?? '' } };
  }
}

/** The attempts and the source of a read through cache nodes, in the shapes of the report. */
function cacheReport(read: CacheRead): { attempts: PreimageReadAttempt[]; servedBy?: PreimageReadSource } {
  const attempts = read.attempts.map(attempt => ({
    source: { tag: 'CacheProvider' as const, value: { id: prefixed(attempt.provider.id) } },
    outcome: outcome(attempt),
    ms: Math.round(attempt.ms),
  }));
  const served = read.served;
  if (served === undefined) {
    return { attempts };
  }
  const value: Extract<PreimageReadSource, { tag: 'CacheProvider' }>['value'] = {
    id: prefixed(served.provider.id),
    origin: origin(served.origin),
    rank: served.rank,
    home: served.home,
  };
  if (served.provider.name !== undefined) {
    value.name = served.provider.name;
  }
  if (served.provider.region !== undefined) {
    value.region = served.provider.region;
  }
  if (served.providerMs !== undefined) {
    value.providerMs = served.providerMs;
  }
  if (served.trace !== undefined) {
    value.trace = served.trace;
  }
  return { attempts, servedBy: { tag: 'CacheProvider', value } };
}

/** One read of `cid` through dotli's Bulletin path: bitswap, or the IPFS gateway in `rpc-gateway` mode. */
async function readBulletin(
  cid: string,
  key: Uint8Array,
): Promise<{ value?: Uint8Array; attempt: PreimageReadAttempt; via: 'Bitswap' | 'Gateway' }> {
  const via: 'Bitswap' | 'Gateway' = getBackend() === 'rpc-gateway' ? 'Gateway' : 'Bitswap';
  const source: PreimageReadAttempt['source'] = { tag: 'Bulletin', value: { via } };
  const started = Date.now();
  const aborter = new AbortController();
  const timer = setTimeout(() => {
    aborter.abort();
  }, BULLETIN_TIMEOUT_MS);
  try {
    const value = via === 'Gateway' ? (await fetchFromIpfs(cid)).data : await bitswapGet(cid, aborter.signal);
    const ms = Date.now() - started;
    if (value.length === 0) {
      return { attempt: { source, outcome: { tag: 'Miss' }, ms }, via };
    }
    if (!sameBytes(blake2b(value, { dkLen: 32 }), key)) {
      return { attempt: { source, outcome: { tag: 'BadBytes' }, ms }, via };
    }
    return { value, attempt: { source, outcome: { tag: 'Served' }, ms }, via };
  } catch (err) {
    const reason = aborter.signal.aborted
      ? `no answer in ${String(BULLETIN_TIMEOUT_MS / 1000)} s`
      : serializeError(err);
    return { attempt: { source, outcome: { tag: 'Failed', value: { reason } }, ms: Date.now() - started }, via };
  } finally {
    clearTimeout(timer);
  }
}

async function read(
  key: Uint8Array,
  route: PreimageReadRoute,
  skipHostCaches: boolean,
): Promise<RemotePreimageReadResponse> {
  const started = Date.now();
  const keyHex = toHex(key);
  const cid = hashToCid(keyHex).toString();
  const attempts: PreimageReadAttempt[] = [];
  const answer = (value: Uint8Array | undefined, servedBy?: PreimageReadSource): RemotePreimageReadResponse => {
    if (value !== undefined) {
      rememberPreimage(keyHex, value);
    }
    const report: RemotePreimageReadResponse['report'] = { attempts, hostMs: Date.now() - started };
    if (servedBy !== undefined) {
      report.servedBy = servedBy;
    }
    return value === undefined ? { report } : { value: hex(value), report };
  };

  const cached = skipHostCaches ? undefined : cachedPreimage(keyHex);
  if (cached !== undefined) {
    attempts.push({ source: { tag: 'HostCache' }, outcome: { tag: 'Served' }, ms: 0 });
    return answer(cached, { tag: 'HostCache' });
  }

  if (route.tag !== 'Bulletin') {
    const cache = getCacheNodes();
    if (cache === null) {
      if (route.tag !== 'Auto') {
        throw new Error('no cache providers: turn on Settings, Experimental, Cache nodes');
      }
    } else {
      const only = route.tag === 'CacheProvider' ? route.value.id.replace(/^0x/, '').toLowerCase() : undefined;
      if (only !== undefined && !(await cache.providers()).some(provider => provider.id === only)) {
        throw new Error(`the cache provider 0x${only} is not in the provider set`);
      }
      const cacheStarted = Date.now();
      const result = await cache.read(key, cid, only === undefined ? {} : { only });
      reportCacheRead(keyHex, cid, result, Date.now() - cacheStarted);
      const report = cacheReport(result);
      attempts.push(...report.attempts);
      if (result.value !== undefined) {
        return answer(result.value, report.servedBy);
      }
    }
    if (route.tag !== 'Auto') {
      return answer(undefined);
    }
  }

  const bulletin = await readBulletin(cid, key);
  attempts.push(bulletin.attempt);
  return answer(
    bulletin.value,
    bulletin.value === undefined ? undefined : { tag: 'Bulletin', value: { via: bulletin.via } },
  );
}

export function createPreimageReadAdapter(): Required<PreimageReadHost> {
  return { readPreimage: read };
}
