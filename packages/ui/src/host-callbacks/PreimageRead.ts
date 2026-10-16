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
// `Preimage.retain`: the host pays cache nodes in advance to keep one or more items for a period. For each item it picks
// a home node of the item (or the node of the request). It shows one confirmation with the size, the period, the node
// and the price of each item, and the person accepts or declines. A dry run answers the same facts and the price, and
// shows and pays nothing. The callback can only throw an error, which the product gets as `Unknown` with the text. So
// the text starts with the name of the error: `Declined`, `NotFound`, `NotAvailable`, `PeriodTooLong` (with the limit)
// or `Failed`. An item with `renew` is a lease: the node charges one day at a time until the end of the period, or
// until the person stops it when the period is 0. Its price is the price of one day.
//
// `Preimage.cacheProviders`: the provider set in the host's order for an item, so a person can pick the node.
//
// `Preimage.stopRetention`: the node stops the renewal of a lease, and keeps the content until the end of the paid day.
// The core asks for the `PreimageRetain` permission before it calls the host, so the host does not ask again.

import type { PreimageReadHost } from '@parity/truapi-host';
import type {
  CacheOrigin,
  PreimageReadAttempt,
  PreimageReadOutcome,
  PreimageReadRoute,
  PreimageReadSource,
  PreimageTarget,
  RemotePreimageCacheAccountRequest,
  RemotePreimageCacheAccountResponse,
  RemotePreimageCacheProvidersRequest,
  RemotePreimageCacheProvidersResponse,
  RemotePreimageReadResponse,
  RemotePreimageReadTorrentRequest,
  RemotePreimageReadTorrentResponse,
  RemotePreimageRetainRequest,
  RemotePreimageRetainResponse,
  RemotePreimageRetentionsRequest,
  RemotePreimageRetentionsResponse,
  RemotePreimageStopRetentionRequest,
  RemotePreimageStopRetentionResponse,
  RetainItem,
  RetainOutcome,
} from '@parity/truapi';
import { blake2b } from '@noble/hashes/blake2.js';
import { getActiveServicesConfig, getBackend } from '@dotli/config';
import {
  bitswapGet,
  blockMatchesCid,
  CacheRetainError,
  DAY_SECS,
  dagSize,
  isDagPb,
  normalCid,
  rawTwin,
  fetchFromIpfs,
  hashToCid,
  leaseDayPrice,
  parseMagnet,
  retentionPrice,
  retentionSplit,
  torrentId,
  type CacheAccount,
  type CacheNodes,
  type CacheProvider,
  type CacheOrigin as NodeOrigin,
  type CacheRead,
} from '@dotli/content';
import { fromHex, log, serializeError, toHex } from '@dotli/shared';

import { createBlockingModalScope, type BlockingModalScope } from '../blocking-modal-queue.js';
import { ERRORS } from '../errors.js';
import { showPreimageRetainModal, type PreimageRetainItemReview } from '../preimage-modal.js';
import { getCacheNodes, reportCacheRead } from './cache-nodes.js';
import { resolveDotNameCid } from './dot-names.js';
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
  cache: CacheNodes | null = getCacheNodes(),
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

async function readTorrent(
  request: RemotePreimageReadTorrentRequest,
  cache: CacheNodes | null,
): Promise<RemotePreimageReadTorrentResponse> {
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
async function cacheAccount(
  request: RemotePreimageCacheAccountRequest,
  cache: CacheNodes | null,
): Promise<RemotePreimageCacheAccountResponse> {
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
    readPricePerMib: BigInt(account.readPricePerMib),
    retentionPrice: BigInt(account.retentionPrice),
    retentionUnitSecs: BigInt(account.retentionUnitSecs),
  };
}

const RETAIN_ERRORS = {
  'not-found': 'NotFound',
  'period-too-long': 'PeriodTooLong',
  'not-available': 'NotAvailable',
  failed: 'Failed',
} as const;

/** The CID of a target: a preimage key, a CID in its CIDv1 form, or the CID of the contenthash of a DotNS name. */
async function targetCid(target: PreimageTarget): Promise<string> {
  switch (target.tag) {
    case 'Key':
      return hashToCid(target.value.toLowerCase()).toString();
    case 'Cid':
      try {
        return normalCid(target.value);
      } catch {
        throw new Error(`Failed: ${target.value} is not a CID`);
      }
    case 'DotNs': {
      const cid = await resolveDotNameCid(target.value, getActiveServicesConfig().dotns.TLD);
      if (cid === null) {
        throw new Error(`NotFound: ${target.value} has no content`);
      }
      return normalCid(cid);
    }
  }
}

/**
 * One block of Bulletin by its CID, checked against the CID: from the cache nodes when they have it, else from Bulletin
 * (bitswap, or the gateway). For a dag-pb CID, the block itself, by its raw twin.
 */
async function readBlock(cid: string, cache: CacheNodes | null): Promise<Uint8Array> {
  const twin = rawTwin(cid);
  const read = cache === null ? undefined : await cache.readBlock(cid).catch(() => undefined);
  if (read?.value !== undefined) {
    return read.value;
  }
  const bytes = getBackend() === 'rpc-gateway' ? (await fetchFromIpfs(twin)).data : await bitswapGet(twin);
  if (!blockMatchesCid(twin, bytes)) {
    throw new Error(`Failed: Bulletin sent a block that is not ${cid}`);
  }
  return bytes;
}

/** The size that a retention of a CID pays for, and its pieces: the block, or for a dag-pb DAG all its blocks. */
async function cidSize(cid: string, cache: CacheNodes | null): Promise<{ size: number; pieces: number }> {
  let block: Uint8Array;
  try {
    block = await readBlock(cid, cache);
  } catch (err) {
    throw new Error(`NotFound: no source has ${cid} (${err instanceof Error ? err.message : String(err)})`, {
      cause: err,
    });
  }
  if (!isDagPb(cid)) {
    return { size: block.length, pieces: 1 };
  }
  const dag = dagSize(block);
  if (dag === null) {
    throw new Error(`Failed: ${cid} is not a UnixFS file with sized links`);
  }
  return { size: dag.size, pieces: dag.links + 1 };
}

/** What the host learned of one item before it pays: the CID, the size, the node, and the price on that node. */
interface PlannedItem {
  item: RetainItem;
  cid: string;
  size: number;
  /** The blocks that the provider will keep: the root and its pieces. */
  pieces: number;
  /** For a lease, the end of the renewals from now, or 0 for a lease without an end. */
  periodSecs: number;
  /** A lease: the node charges one day at a time. */
  renew: boolean;
  provider: CacheProvider;
  account?: CacheAccount;
  /** The price of the period, or for a lease the price of one day. */
  price?: number;
}

async function planItem(item: RetainItem, cache: CacheNodes | null): Promise<PlannedItem> {
  if (cache === null) {
    throw new Error('Failed: no cache providers. Turn on Settings, Experimental, Cache nodes');
  }
  const cid = await targetCid(item.target);
  let size = item.size === undefined ? undefined : Number(item.size);
  let pieces = 1;
  if (item.target.tag === 'Key') {
    if (size === undefined) {
      // The host reads the value once to learn its size: from its own cache, the cache nodes or Bulletin.
      const answer = await read(fromHex(item.target.value), { tag: 'Auto' }, false, cache);
      if (answer.value === undefined) {
        throw new Error('NotFound: no source has the preimage yet');
      }
      size = (answer.value.length - 2) / 2;
    }
  } else {
    // The host reads only the root block: the links of a DAG give the size of all its blocks.
    const measured = await cidSize(cid, cache);
    pieces = measured.pieces;
    size ??= measured.size;
  }
  const periodSecs = Number(item.periodSecs);
  const provider = await cache.retentionProvider(cid, item.provider?.replace(/^0x/, '').toLowerCase());
  const account: CacheAccount | undefined = await cache.account({ only: provider.id }).catch(() => undefined);
  const renew = item.renew;
  const planned: PlannedItem = { item, cid, size, pieces, periodSecs, renew, provider };
  if (account !== undefined) {
    planned.account = account;
    planned.price = renew
      ? leaseDayPrice(size, account)
      : retentionPrice(size, periodSecs, account.retentionPrice, account.retentionUnitSecs);
  }
  return planned;
}

function retainOutcome(
  planned: PlannedItem,
  state: RetainOutcome['state'],
  kept?: { until: number; size: number; chunks: number; charged: number },
): RetainOutcome {
  const pieces = kept === undefined || kept.chunks === 0 ? planned.pieces : kept.chunks + 1;
  const price = planned.price ?? kept?.charged ?? 0;
  // Without a pin, a lease pays the first day, and a retention paid in advance pays the full period.
  const now = Math.floor(Date.now() / 1000);
  const firstDay = planned.periodSecs === 0 ? DAY_SECS : Math.min(DAY_SECS, planned.periodSecs);
  const split = planned.account === undefined ? { free: 0, paid: 0, short: 0 } : retentionSplit(price, planned.account);
  const answer: RetainOutcome = {
    cid: planned.cid,
    provider: prefixed(planned.provider.id),
    kind: pieces > 1 ? 'File' : 'Raw',
    size: BigInt(kept?.size ?? planned.size),
    pieces,
    until: BigInt(kept?.until ?? now + (planned.renew ? firstDay : planned.periodSecs)),
    price: BigInt(price),
    charged: BigInt(kept?.charged ?? 0),
    free: BigInt(split.free),
    paid: BigInt(split.paid),
    short: BigInt(split.short),
    renews: planned.renew,
    state,
  };
  if (planned.provider.name !== undefined) {
    answer.name = planned.provider.name;
  }
  if (planned.provider.region !== undefined) {
    answer.region = planned.provider.region;
  }
  if (planned.provider.operator !== undefined) {
    answer.operator = planned.provider.operator;
  }
  return answer;
}

/**
 * `Preimage.retain`: keep each item on a cache node for its period, after the person accepts the prices. A dry run
 * answers the same outcomes as `Quote`, and shows and pays nothing.
 */
async function retain(
  label: string,
  modalScope: BlockingModalScope,
  request: RemotePreimageRetainRequest,
  cache: CacheNodes | null,
): Promise<RemotePreimageRetainResponse> {
  if (cache === null) {
    throw new Error('Failed: no cache providers. Turn on Settings, Experimental, Cache nodes');
  }
  try {
    const planned: PlannedItem[] = [];
    for (const item of request.items) {
      planned.push(await planItem(item, cache));
    }
    if (request.dryRun) {
      return { items: planned.map(item => retainOutcome(item, { tag: 'Quote' })) };
    }
    const funds = planned[0]?.account;
    const accepted = await modalScope.enqueue(signal =>
      showPreimageRetainModal(
        {
          label,
          items: planned.map(item => {
            const review: PreimageRetainItemReview = {
              size: item.size,
              periodSecs: item.periodSecs,
              node: [item.provider.name ?? `${item.provider.id.slice(0, 8)}…`, item.provider.region]
                .filter(Boolean)
                .join(', '),
            };
            if (item.item.target.tag === 'DotNs') {
              review.what = item.item.target.value;
            } else if (planned.length > 1) {
              review.what = `${item.cid.slice(0, 12)}…`;
            }
            if (item.price !== undefined) {
              review.price = item.price;
            }
            if (item.renew) {
              review.renews = true;
            }
            return review;
          }),
          ...(funds === undefined
            ? {}
            : { funds: { free: Math.min(funds.allowance, funds.allowanceRetention), paid: funds.paid } }),
        },
        signal,
      ),
    );
    if (!accepted) {
      throw new Error(ERRORS.PREIMAGE_RETAIN_DECLINED);
    }
    const items: RetainOutcome[] = [];
    for (const item of planned) {
      const kept = await cache.retain(item.provider, item.cid, item.size, item.periodSecs, {
        background: true,
        renew: item.renew,
        ...(item.price === undefined ? {} : { maxPerDay: item.price }),
      });
      log.debug(`[cache] ${item.provider.api} keeps ${item.cid} until ${String(kept.until)} (${kept.state})`);
      const state: RetainOutcome['state'] =
        kept.state === 'fetching' && kept.pinId !== undefined
          ? { tag: 'Fetching', value: { pinId: kept.pinId } }
          : { tag: 'Kept' };
      items.push(retainOutcome(item, state, kept));
    }
    return { items };
  } catch (err) {
    if (err instanceof CacheRetainError) {
      throw new Error(`${RETAIN_ERRORS[err.kind]}: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

/** `Preimage.cacheProviders`: the provider set in the host's order for the target, as a person can pick from it. */
async function cacheProviders(
  request: RemotePreimageCacheProvidersRequest,
  cache: CacheNodes | null,
): Promise<RemotePreimageCacheProvidersResponse> {
  if (cache === null) {
    throw new Error('no cache providers: turn on Settings, Experimental, Cache nodes');
  }
  const target = request.target;
  const contentId = target === undefined ? undefined : await targetCid(target).catch(() => undefined);
  const choices = await cache.choices(contentId);
  return {
    providers: choices.map(choice => {
      const provider: RemotePreimageCacheProvidersResponse['providers'][number] = {
        id: prefixed(choice.provider.id),
        source: 'Registry',
        home: choice.home,
        failedRecently: choice.failedRecently,
      };
      if (choice.provider.name !== undefined) {
        provider.name = choice.provider.name;
      }
      if (choice.provider.region !== undefined) {
        provider.region = choice.provider.region;
      }
      if (choice.provider.operator !== undefined) {
        provider.operator = choice.provider.operator;
      }
      if (choice.latencyMs !== undefined) {
        provider.latencyMs = Math.min(Math.round(choice.latencyMs), 0xffff_ffff);
      }
      return provider;
    }),
  };
}

const RETENTION_STATES = {
  kept: { tag: 'Kept' },
  lost: { tag: 'Lost' },
  ended: { tag: 'Ended' },
  unknown: { tag: 'Unknown' },
} as const;

/**
 * `Preimage.retentions`: the retentions of the cache payer, from the ledger of a provider, with what each provider holds
 * now.
 */
async function retentions(
  request: RemotePreimageRetentionsRequest,
  cache: CacheNodes | null,
): Promise<RemotePreimageRetentionsResponse> {
  if (cache === null) {
    throw new Error('no cache providers: turn on Settings, Experimental, Cache nodes');
  }
  const only = request.provider?.replace(/^0x/, '').toLowerCase();
  const answer = await cache.retentions(only === undefined ? {} : { only });
  return {
    payer: prefixed(answer.payer),
    retentions: answer.leases.map(lease => {
      const retention: RemotePreimageRetentionsResponse['retentions'][number] = {
        cid: lease.content,
        provider: prefixed(lease.provider.id),
        size: BigInt(lease.size),
        pieces: lease.total,
        from: BigInt(lease.from),
        until: BigInt(lease.until),
        paidUntil: BigInt(lease.paidUntil),
        charged: BigInt(lease.charged),
        perDay: BigInt(lease.perDay),
        renews: lease.renews,
        state:
          lease.state === 'fetching'
            ? { tag: 'Fetching', value: { pieces: lease.pieces, total: lease.total } }
            : RETENTION_STATES[lease.state],
      };
      const holder: Partial<CacheProvider> = lease.provider;
      if (holder.name !== undefined) {
        retention.name = holder.name;
      }
      if (holder.region !== undefined) {
        retention.region = holder.region;
      }
      if (holder.operator !== undefined) {
        retention.operator = holder.operator;
      }
      return retention;
    }),
  };
}

/**
 * `Preimage.stopRetention`: stop the renewal of the leases of a CID on a provider. The answer is the end of the paid
 * day from a new read of the retentions, or 0 when the payer has no retention of the CID on that provider.
 */
async function stopRetention(
  request: RemotePreimageStopRetentionRequest,
  cache: CacheNodes | null,
): Promise<RemotePreimageStopRetentionResponse> {
  if (cache === null) {
    throw new Error('Failed: no cache providers. Turn on Settings, Experimental, Cache nodes');
  }
  const id = request.provider.replace(/^0x/, '').toLowerCase();
  const provider = (await cache.providers()).find(candidate => candidate.id === id);
  if (provider === undefined) {
    throw new Error(`Failed: the cache provider 0x${id} is not in the provider set`);
  }
  const cid = request.cid.trim();
  try {
    const stopped = await cache.stop(cid, provider);
    log.debug(`[cache] ${provider.api} stopped ${String(stopped)} leases of ${cid}`);
  } catch (err) {
    if (err instanceof CacheRetainError) {
      throw new Error(`${RETAIN_ERRORS[err.kind]}: ${err.message}`, { cause: err });
    }
    throw new Error(`Failed: ${serializeError(err)}`, { cause: err });
  }
  const { leases } = await cache.retentions({ only: provider.id });
  const paidUntil = leases
    .filter(lease => lease.content === cid && lease.provider.id === provider.id)
    .reduce((end, lease) => Math.max(end, lease.paidUntil), 0);
  return { until: BigInt(paidUntil) };
}

export function createPreimageReadAdapter(
  label = '',
  modalScope: BlockingModalScope = createBlockingModalScope(),
): Required<PreimageReadHost> {
  // The cache payer of this product for the signed-in person, which the core sets before each cache call. Without one,
  // the cache nodes of the setting pay with its payer seed or the shared test payer.
  let payerSeed: Uint8Array | undefined;
  const nodes = (): CacheNodes | null => getCacheNodes(payerSeed);
  return {
    readPreimage: (key, route, skipHostCaches) => read(key, route, skipHostCaches, nodes()),
    readTorrent: request => readTorrent(request, nodes()),
    cacheAccount: request => cacheAccount(request, nodes()),
    retainPreimage: request => retain(label, modalScope, request, nodes()),
    cacheProviders: request => cacheProviders(request, nodes()),
    retentions: request => retentions(request, nodes()),
    stopRetention: request => stopRetention(request, nodes()),
    setCachePayer: seed => {
      payerSeed = seed.length === 32 ? seed : undefined;
      return Promise.resolve();
    },
  };
}
