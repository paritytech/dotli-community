// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// `Preimage.read`: one read of a preimage through a route that the product chooses, with a report of every source that
// the host asked. Products that show or measure the cache use it (the demo product cache-demo.paseo). There are four
// routes. `Auto` is the host's normal order: cache nodes when the setting is on, then Bulletin. The other routes are
// Bulletin only, cache nodes only, and one cache node. With `skipHostCaches` the page's own preimage cache does not
// answer, so the read measures the network.
//
// `Preimage.readTorrent`: one file of a BitTorrent torrent, from a magnet link, through cache nodes only (a torrent is
// not on Bulletin). A node gets the file from the swarm, its store or a peer, and sends its span; the host checks the
// pieces against the torrent before it pays. The core sets the preimage key of the file, and the nodes also keep the
// file under that key, so the product can read it again with `Preimage.read`. A node downloads in the background: until it
// has the file, the answer has no value and the progress of the download, and the product reads again.
//
// `Preimage.cacheAccount`: the account of the payer of the cache nodes in the ledger of a node, so a product can show
// the free allowance, the paid credits and the prices.
//
// `Preimage.retain`: the host pays a cache node in advance to keep a preimage for a period. It picks a home node of the
// key (or the node of the request), shows the size, the period, the node and the price, and the person accepts or
// declines. The callback can only throw an error, which the product gets as `Unknown` with the text. So the text starts
// with the name of the error: `Declined`, `NotFound`, `NotAvailable`, `PeriodTooLong` (with the limit) or `Failed`.

import type { PreimageReadHost } from '@parity/truapi-host';
import type {
  CacheOrigin,
  PreimageReadAttempt,
  PreimageReadOutcome,
  PreimageReadRoute,
  PreimageReadSource,
  RemotePreimageCacheAccountRequest,
  RemotePreimageCacheAccountResponse,
  RemotePreimageReadResponse,
  RemotePreimageReadTorrentRequest,
  RemotePreimageReadTorrentResponse,
  RemotePreimageRetainRequest,
  RemotePreimageRetainResponse,
} from '@parity/truapi';
import { blake2b } from '@noble/hashes/blake2.js';
import { getBackend } from '@dotli/config';
import {
  bitswapGet,
  CacheRetainError,
  fetchFromIpfs,
  hashToCid,
  parseMagnet,
  retentionPrice,
  torrentId,
  type CacheAccount,
  type CacheOrigin as NodeOrigin,
  type CacheRead,
} from '@dotli/content';
import { fromHex, log, serializeError, toHex } from '@dotli/shared';

import { createBlockingModalScope, type BlockingModalScope } from '../blocking-modal-queue.js';
import { ERRORS } from '../errors.js';
import { showPreimageRetainModal, type PreimageRetainReview } from '../preimage-modal.js';
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
  if (served.price !== undefined) {
    value.price = BigInt(served.price);
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

// The largest file that the host answers whole. TrUAPI carries a value as one hex string, and a JavaScript string has a
// size limit, so a larger file goes in parts.
const WHOLE_LIMIT = 32 * 1024 * 1024;
// The largest part in one answer.
const PART_LIMIT = 8 * 1024 * 1024;
// The checked torrent files that the page keeps for the reads of their parts, by content id. The newest ones stay.
const KEPT_TORRENTS = 4;

interface KeptTorrent {
  value: Uint8Array;
  key: HexString;
  file: number;
  name?: string;
  files: RemotePreimageReadTorrentResponse['files'];
  report: RemotePreimageReadTorrentResponse['report'];
}

const keptTorrents = new Map<string, KeptTorrent>();

function keepTorrent(contentId: string, kept: KeptTorrent): void {
  keptTorrents.delete(contentId);
  keptTorrents.set(contentId, kept);
  for (const old of keptTorrents.keys()) {
    if (keptTorrents.size <= KEPT_TORRENTS) {
      break;
    }
    keptTorrents.delete(old);
  }
}

// The answer for a part of a checked file.
function partOf(
  kept: KeptTorrent,
  range: NonNullable<RemotePreimageReadTorrentRequest['range']>,
  started: number,
): RemotePreimageReadTorrentResponse {
  const offset = Number(range.offset);
  const end = Math.min(kept.value.length, offset + Math.min(range.length, PART_LIMIT));
  const response: RemotePreimageReadTorrentResponse = {
    value: hex(kept.value.subarray(offset, Math.max(offset, end))),
    key: kept.key,
    size: BigInt(kept.value.length),
    file: kept.file,
    report: { ...kept.report, hostMs: Date.now() - started },
    files: kept.files,
  };
  if (kept.name !== undefined) {
    response.name = kept.name;
  }
  return response;
}

async function readTorrent(request: RemotePreimageReadTorrentRequest): Promise<RemotePreimageReadTorrentResponse> {
  const started = Date.now();
  const route = request.route;
  if (route.tag === 'Bulletin') {
    throw new Error('a torrent is not on Bulletin: use the route Auto, Cache or a cache provider');
  }
  // A part of a file that the page checked before comes from memory.
  const range = request.range;
  if (range !== undefined) {
    const magnet = parseMagnet(request.magnet);
    const kept = keptTorrents.get(torrentId(magnet.infoHash, request.file ?? magnet.file ?? 0));
    if (kept !== undefined) {
      return partOf(kept, range, started);
    }
  }
  const cache = getCacheNodes();
  if (cache === null) {
    throw new Error('no cache providers: turn on Settings, Experimental, Cache nodes');
  }
  const only = route.tag === 'CacheProvider' ? route.value.id.replace(/^0x/, '').toLowerCase() : undefined;
  if (only !== undefined && !(await cache.providers()).some(provider => provider.id === only)) {
    throw new Error(`the cache provider 0x${only} is not in the provider set`);
  }
  const result = await cache.readTorrent(request.magnet, request.file, only === undefined ? {} : { only });
  reportCacheRead(result.contentId, result.contentId, result, Date.now() - started);
  const { attempts, servedBy } = cacheReport(result);
  const report: RemotePreimageReadTorrentResponse['report'] = { attempts, hostMs: Date.now() - started };
  if (servedBy !== undefined) {
    report.servedBy = servedBy;
  }
  const files = (result.files ?? []).map(file => ({ index: file.index, path: file.path, size: BigInt(file.size) }));
  const response: RemotePreimageReadTorrentResponse = { file: result.file, report, files };
  if (result.name !== undefined) {
    response.name = result.name;
  }
  if (result.value !== undefined) {
    // The page keeps the file under its preimage key too, as after a read.
    const key = toHex(blake2b(result.value, { dkLen: 32 }));
    rememberPreimage(key, result.value);
    if (range === undefined && result.value.length <= WHOLE_LIMIT) {
      response.value = hex(result.value);
    } else {
      // A part, or a large file: the page keeps the file, and the product reads it in parts. The answer for a large
      // file without a range has no value, but the key and the size.
      const kept: KeptTorrent = { value: result.value, key, file: result.file, files, report };
      if (result.name !== undefined) {
        kept.name = result.name;
      }
      keepTorrent(result.contentId, kept);
      if (range !== undefined) {
        return partOf(kept, range, started);
      }
      response.key = key;
      response.size = BigInt(result.value.length);
    }
  }
  const progress = result.progress;
  if (progress !== undefined) {
    // The provider still downloads the file: the product reads again later, and shows how far it is.
    const running: NonNullable<RemotePreimageReadTorrentResponse['progress']> = {
      provider: prefixed(progress.provider.id),
      state: TORRENT_STATES[progress.state],
      downloaded: BigInt(progress.downloaded),
      peers: progress.peers,
      elapsedMs: BigInt(progress.elapsedMs),
    };
    if (progress.size !== undefined) {
      running.size = BigInt(progress.size);
    }
    response.progress = running;
    if (progress.name !== undefined) {
      response.name = progress.name;
    }
  }
  return response;
}

const TORRENT_STATES = {
  starting: 'Starting',
  metadata: 'Metadata',
  downloading: 'Downloading',
  importing: 'Importing',
  receiving: 'Receiving',
} as const;

/** `Preimage.cacheAccount`: the account of the payer of the cache nodes, from the ledger of a provider. */
async function cacheAccount(request: RemotePreimageCacheAccountRequest): Promise<RemotePreimageCacheAccountResponse> {
  const cache = getCacheNodes();
  if (cache === null) {
    throw new Error('no cache providers: turn on Settings, Experimental, Cache nodes');
  }
  const only = request.provider?.replace(/^0x/, '').toLowerCase();
  const account = await cache.account(only === undefined ? {} : { only });
  return {
    payer: prefixed(account.payer),
    provider: prefixed(account.provider.id),
    allowance: BigInt(account.allowance),
    allowanceRetention: BigInt(account.allowanceRetention),
    paid: BigInt(account.paid),
    allowancePerDay: BigInt(account.allowancePerDay),
    retentionAllowancePerDay: BigInt(account.retentionAllowancePerDay),
    readPrice: BigInt(account.readPrice),
    retentionPrice: BigInt(account.retentionPrice),
  };
}

const RETAIN_ERRORS = {
  'not-found': 'NotFound',
  'period-too-long': 'PeriodTooLong',
  'not-available': 'NotAvailable',
  failed: 'Failed',
} as const;

/** `Preimage.retain`: keep a preimage on a cache node for a period, after the person accepts the price. */
async function retain(
  label: string,
  modalScope: BlockingModalScope,
  request: RemotePreimageRetainRequest,
): Promise<RemotePreimageRetainResponse> {
  const cache = getCacheNodes();
  if (cache === null) {
    throw new Error('Failed: no cache providers. Turn on Settings, Experimental, Cache nodes');
  }
  const keyHex = request.key.toLowerCase() as HexString;
  const cid = hashToCid(keyHex).toString();
  let size = request.size === undefined ? undefined : Number(request.size);
  if (size === undefined) {
    // The host reads the value once to learn its size: from its own cache, the cache nodes or Bulletin.
    const answer = await read(fromHex(keyHex), { tag: 'Auto' }, false);
    if (answer.value === undefined) {
      throw new Error('NotFound: no source has the preimage yet');
    }
    size = (answer.value.length - 2) / 2;
  }
  const periodSecs = Number(request.periodSecs);
  try {
    const provider = await cache.retentionProvider(cid, request.provider?.replace(/^0x/, '').toLowerCase());
    const account: CacheAccount | undefined = await cache.account({ only: provider.id }).catch(() => undefined);
    const review: PreimageRetainReview = {
      label,
      size,
      periodSecs,
      node: [provider.name ?? `${provider.id.slice(0, 8)}…`, provider.region].filter(Boolean).join(', '),
    };
    if (account !== undefined) {
      review.price = retentionPrice(size, periodSecs, account.retentionPrice);
      review.funds = { free: Math.min(account.allowance, account.allowanceRetention), paid: account.paid };
    }
    const accepted = await modalScope.enqueue(signal => showPreimageRetainModal(review, signal));
    if (!accepted) {
      throw new Error(ERRORS.PREIMAGE_RETAIN_DECLINED);
    }
    const kept = await cache.retain(provider, cid, size, periodSecs);
    log.debug(`[cache] ${provider.api} keeps ${cid} until ${String(kept.until)} for ${String(kept.charged)}`);
    const response: RemotePreimageRetainResponse = {
      until: BigInt(kept.until),
      provider: prefixed(provider.id),
      size: BigInt(kept.size),
      chunks: kept.chunks,
      charged: BigInt(kept.charged),
    };
    if (provider.name !== undefined) {
      response.name = provider.name;
    }
    if (provider.region !== undefined) {
      response.region = provider.region;
    }
    return response;
  } catch (err) {
    if (err instanceof CacheRetainError) {
      throw new Error(`${RETAIN_ERRORS[err.kind]}: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

export function createPreimageReadAdapter(
  label = '',
  modalScope: BlockingModalScope = createBlockingModalScope(),
): Required<PreimageReadHost> {
  return {
    readPreimage: read,
    readTorrent,
    cacheAccount,
    retainPreimage: request => retain(label, modalScope, request),
  };
}
