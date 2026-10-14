// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Cache nodes keep verified copies of Bulletin preimages near their users and serve them faster than Bulletin. A read
// asks the providers of the provider set in quality order, each with a read request that the payer signs. It checks the
// bytes against the key, and only then pays the provider that served, with a signed receipt. A provider that sends bad
// bytes gets no receipt. The messages are those of the cache prototype (cache/src/payment.rs) and of the CLI host
// (truapi-host-cli, cache_lookup.rs). The three share test vectors.
//
// The provider order: providers that failed in the last 30 s go last. The others go by the latency that this host
// measured: an average with more weight on recent reads, and 50 ms before the first read. The home nodes of the content
// count at half their latency. They are the 3 providers with the highest blake2b-256(CID || endpoint id), the rank that
// the cache nodes use too. Every fourth read tries an unmeasured provider first.
//
// Retention: the payer pays a provider in advance to keep content until a time. It signs a retention authorization
// for the size and the window, and the provider fetches the content, checks it against its CID, keeps it and charges.

import { blake2b } from '@noble/hashes/blake2.js';
import { getPublicKey, secretFromSeed, sign } from '@scure/sr25519';
import { log } from '@dotli/shared';

import { parseMagnet, type TorrentListedFile, torrentId, verifySpan } from './torrent.js';

/** One provider of the provider set that a browser can call. */
export interface CacheProvider {
  /** The endpoint id: 64 hex digits, no 0x. */
  id: string;
  /** The base URL of the provider's API. */
  api: string;
  name?: string;
  region?: string;
}

/** Where a provider got the content: its own store, another provider (by endpoint id), or Bulletin. */
export type CacheOrigin = { kind: 'local' } | { kind: 'peer'; id: string } | { kind: 'source' } | { kind: 'unknown' };

export type CacheOutcome = 'served' | 'miss' | 'bad-bytes' | 'refused' | 'failed';

export interface CacheAttempt {
  provider: CacheProvider;
  outcome: CacheOutcome;
  reason?: string;
  ms: number;
}

export interface CacheServed {
  provider: CacheProvider;
  origin: CacheOrigin;
  /** The provider's position in the order of this read, from 0. */
  rank: number;
  home: boolean;
  /** The time that the provider reports for its own work. */
  providerMs?: number;
  /** The provider's trace of its steps (`x-cache-trace`), as JSON text. */
  trace?: string;
  /** The price of the read in the provider's ledger (`x-cache-price`), which the receipt pays. */
  price?: number;
}

/**
 * The account of the payer in the ledger of a provider (`GET /account/<payer>`): what is left of the free allowance
 * today and the part of it for retention, the paid credits, the daily allowance, and the prices.
 */
export interface CacheAccount {
  payer: string;
  provider: CacheProvider;
  allowance: number;
  allowanceRetention: number;
  paid: number;
  allowancePerDay: number;
  retentionAllowancePerDay: number;
  readPrice: number;
  retentionPrice: number;
}

/** What a provider keeps after a pin: the end, the size that the retention paid for, the chunks and the charge. */
export interface CacheRetention {
  provider: CacheProvider;
  /** Unix seconds. */
  until: number;
  size: number;
  /** The chunks of a chunked file that the provider keeps with its manifest. */
  chunks: number;
  charged: number;
}

/** Why a provider did not keep content. */
export type CacheRetainFailure = 'not-found' | 'period-too-long' | 'not-available' | 'failed';

/** A pin that a provider refused, with the reason in a kind that a product can act on. */
export class CacheRetainError extends Error {
  readonly kind: CacheRetainFailure;
  /** The longest period that the provider accepts, for `period-too-long`. */
  readonly maxSecs: number | undefined;

  constructor(kind: CacheRetainFailure, message: string, maxSecs?: number) {
    super(message);
    this.name = 'CacheRetainError';
    this.kind = kind;
    this.maxSecs = maxSecs;
  }
}

/** The error of a pin from the status and the text of the node. */
export function pinError(status: number, text: string): CacheRetainError {
  if (status === 402) {
    return new CacheRetainError('not-available', `the payer cannot pay: ${text}`);
  }
  if (status === 404) {
    return new CacheRetainError('not-found', `no source has the content yet: ${text}`);
  }
  const limit = /a pin ends 1 to (\d+) seconds/.exec(text);
  if (limit?.[1] !== undefined) {
    const maxSecs = Number(limit[1]);
    return new CacheRetainError('period-too-long', `the period is too long: at most ${String(maxSecs)} s`, maxSecs);
  }
  return new CacheRetainError('failed', `${String(status)}: ${text}`);
}

const MIB = 1024 * 1024;
const HOUR_SECS = 3600;

/** The price of retention as the ledger calculates it: `price` for each started MiB of `size` and started hour. */
export function retentionPrice(size: number, secs: number, price: number): number {
  return price * Math.max(1, Math.ceil(size / MIB)) * Math.ceil(secs / HOUR_SECS);
}

/** The facts of a served read from the headers of the provider's answer. */
function servedFrom(response: Response, provider: CacheProvider, rank: number, home: boolean): CacheServed {
  const served: CacheServed = { provider, origin: parseOrigin(response.headers.get('x-cache-origin')), rank, home };
  const elapsed = Number(response.headers.get('x-cache-elapsed-ms'));
  if (Number.isFinite(elapsed) && response.headers.has('x-cache-elapsed-ms')) {
    served.providerMs = elapsed;
  }
  const trace = response.headers.get('x-cache-trace');
  if (trace !== null && trace !== '') {
    served.trace = trace;
  }
  const price = Number(response.headers.get('x-cache-price'));
  if (Number.isFinite(price) && response.headers.has('x-cache-price')) {
    served.price = price;
  }
  return served;
}

/** The result of one read: the value when a provider had it, and every attempt. */
export interface CacheRead {
  value?: Uint8Array;
  served?: CacheServed;
  attempts: CacheAttempt[];
}

/** The result of one torrent read: a `CacheRead`, and the file, its name and its content id at the cache nodes. */
export interface CacheTorrentRead extends CacheRead {
  file: number;
  name?: string;
  contentId: string;
  /** While the provider still downloads the file: what it did so far. There is no value then; read again later. */
  progress?: CacheTorrentProgress;
  /** The files of the torrent, after a read that the host checked. */
  files?: TorrentListedFile[];
}

/** The step of a torrent download at a provider. */
export type CacheTorrentState = 'starting' | 'metadata' | 'downloading' | 'importing' | 'receiving';

/** What a provider did so far for a torrent file that it still downloads (`POST /prefetch`, `GET /progress`). */
export interface CacheTorrentProgress {
  provider: CacheProvider;
  state: CacheTorrentState;
  name?: string;
  size?: number;
  downloaded: number;
  peers: number;
  elapsedMs: number;
}

/** The progress answer of a cache node. */
interface NodeProgress {
  state: string;
  error?: string;
  name?: string;
  size?: number;
  downloaded: number;
  peers: number;
  elapsed_ms: number;
}

/** What the host measured of one provider. */
export interface CacheQuality {
  latencyMs?: number;
  successes: number;
  failures: number;
  /** For this page only: a new page load forgets recent failures. */
  failedAt?: number;
}

export const CACHE_HOMES = 3;
const FAILURE_COOLDOWN_MS = 30_000;
const PRIOR_MS = 50;
const EXPLORE_EVERY = 4;
const NODE_TIMEOUT_MS = 15_000;
// The read of a torrent file that a provider has: it can hold a large span, so the job that receives it can take long.
const TORRENT_TIMEOUT_MS = 3_600_000;
// The longest wait for a pin: the node fetches the content first, for a chunked file each chunk.
const PIN_TIMEOUT_MS = 300_000;
// How long one call waits for the job that receives a torrent file. A small file comes in this time.
const RECEIVE_WAIT_MS = 3_000;

// A job that receives a torrent file from a provider and checks it.
interface TorrentJob {
  provider: CacheProvider;
  started: number;
  received: number;
  size?: number;
  done: Promise<void>;
  result?: TorrentJobResult;
}

// The end of a receive job: its attempt, and the checked file when the provider served it.
type TorrentJobResult =
  | { attempt: CacheAttempt; value?: undefined }
  | { attempt: CacheAttempt; value: Uint8Array; name: string; files: TorrentListedFile[]; served: CacheServed };

// Read the body of a response, and count its bytes in the job.
async function readBody(response: Response, job: TorrentJob): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > 0) {
    job.size = length;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    job.received = bytes.length;
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    job.received += value.length;
  }
  const bytes = new Uint8Array(job.received);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}
const PROVIDERS_TTL_MS = 60_000;
const QUALITY_KEY = 'dotli:cache-quality';
const READ_PREFIX = 'cache-read/1';
const RECEIPT_PREFIX = 'cache-receipt/2';

const encoder = new TextEncoder();

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(text: string): Uint8Array {
  const digits = text.replace(/^0x/, '');
  return Uint8Array.from(digits.match(/../g) ?? [], pair => parseInt(pair, 16));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function u32(n: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, n, true);
  return bytes;
}

function u64(n: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(n), true);
  return bytes;
}

function field(bytes: Uint8Array): Uint8Array {
  return concat(u32(bytes.length), bytes);
}

interface SignedFields {
  transfer: string;
  /** 64 hex digits. */
  payer: string;
  /** 64 hex digits. */
  provider: string;
  /** The CID string. */
  content: string;
}

// The fields that a receipt and a read request share, after the prefix. They are the transfer id, the payer and
// provider keys (32 raw bytes each) and the content id. Text fields have a u32 LE length first.
function signedFields(prefix: string, fields: SignedFields): Uint8Array {
  return concat(
    encoder.encode(prefix),
    field(encoder.encode(fields.transfer)),
    fromHex(fields.payer),
    fromHex(fields.provider),
    field(encoder.encode(fields.content)),
  );
}

/** The bytes that a payer signs to ask one provider for one read: the shared fields and the issue time (u64 LE). */
export function readMessage(fields: SignedFields & { issuedAt: number }): Uint8Array {
  return concat(signedFields(READ_PREFIX, fields), u64(fields.issuedAt));
}

/** The bytes that a payer signs for one delivery: the shared fields, service 0, and size, from and until, all 0. */
export function receiptMessage(fields: SignedFields): Uint8Array {
  return concat(signedFields(RECEIPT_PREFIX, fields), Uint8Array.of(0), u64(0), u64(0), u64(0));
}

/**
 * The bytes that a payer signs to pay in advance for retention: the layout of a receipt, with service 1, the size that
 * the retention pays for, and the window `from` to `until` (Unix seconds).
 */
export function retentionMessage(fields: SignedFields & { size: number; from: number; until: number }): Uint8Array {
  return concat(
    signedFields(RECEIPT_PREFIX, fields),
    Uint8Array.of(1),
    u64(fields.size),
    u64(fields.from),
    u64(fields.until),
  );
}

/** A payer from a 32-byte seed. The function expands the seed as Substrate expands an sr25519 mini secret key. */
export function payerFromSeed(seed: Uint8Array): { secret: Uint8Array; id: string } {
  const secret = secretFromSeed(seed);
  return { secret, id: toHex(getPublicKey(secret)) };
}

/** The seed of a named test payer: blake2b-256 of "ctest-payer/<name>". Anyone can compute it. */
export function testPayerSeed(name: string): Uint8Array {
  return blake2b(encoder.encode(`ctest-payer/${name}`), { dkLen: 32 });
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return a.length - b.length;
}

/** The rank of a provider for a content id: blake2b-256(CID string || endpoint id). Higher ranks first. */
export function rendezvousScore(contentId: string, id: string): Uint8Array {
  return blake2b(concat(encoder.encode(contentId), fromHex(id)), { dkLen: 32 });
}

/** The home nodes of a content id among `ids`: the CACHE_HOMES ids that rank highest by `rendezvousScore`. */
export function homeNodes(contentId: string, ids: string[]): string[] {
  const ranked = [...new Set(ids)].map(id => ({ id, score: rendezvousScore(contentId, id) }));
  ranked.sort((a, b) => compare(b.score, a.score));
  return ranked.slice(0, CACHE_HOMES).map(entry => entry.id);
}

/** The order in which the host asks `providers` for content with the home nodes `homes`. */
export function orderProviders(
  providers: CacheProvider[],
  homes: string[],
  quality: ReadonlyMap<string, CacheQuality>,
  explore: boolean,
  now: number,
): CacheProvider[] {
  const failing = (provider: CacheProvider): boolean => {
    const failedAt = quality.get(provider.id)?.failedAt;
    return failedAt !== undefined && now - failedAt < FAILURE_COOLDOWN_MS;
  };
  const cost = (provider: CacheProvider): number => {
    const latency = quality.get(provider.id)?.latencyMs ?? PRIOR_MS;
    return homes.includes(provider.id) ? Math.floor(latency / 2) : latency;
  };
  const ordered = [...providers].sort((a, b) => Number(failing(a)) - Number(failing(b)) || cost(a) - cost(b));
  if (explore) {
    const index = ordered.findIndex(
      provider => quality.get(provider.id)?.latencyMs === undefined && !failing(provider),
    );
    if (index > 0) {
      ordered.unshift(...ordered.splice(index, 1));
    }
  }
  return ordered;
}

/** `local`, `source`, or `peer:<64 hex>` from the `x-cache-origin` header. Other text is unknown. */
export function parseOrigin(header: string | null): CacheOrigin {
  if (header === 'local') {
    return { kind: 'local' };
  }
  if (header === 'source') {
    return { kind: 'source' };
  }
  const id = /^peer:([0-9a-f]{64})$/.exec(header ?? '')?.[1];
  return id === undefined ? { kind: 'unknown' } : { kind: 'peer', id };
}

/** The provider set from a `GET /providers` answer: the providers that have an API URL. */
export function parseProviders(json: unknown): CacheProvider[] {
  if (!Array.isArray(json)) {
    return [];
  }
  const out: CacheProvider[] = [];
  for (const entry of json as Record<string, unknown>[]) {
    const id = typeof entry['id'] === 'string' ? entry['id'] : '';
    const api = typeof entry['api'] === 'string' ? entry['api'] : '';
    if (!/^[0-9a-f]{64}$/.test(id) || !/^https?:\/\//.test(api)) {
      continue;
    }
    const provider: CacheProvider = { id, api: api.replace(/\/$/, '') };
    if (typeof entry['name'] === 'string') {
      provider.name = entry['name'];
    }
    if (typeof entry['region'] === 'string') {
      provider.region = entry['region'];
    }
    out.push(provider);
  }
  return out;
}

export interface CacheNodesOptions {
  /**
   * Where the provider set is: a node's `GET /providers`, or a static JSON file of the same shape. `loadProviders`
   * replaces it, for example with a read of the provider registry on Asset Hub.
   */
  providersUrl?: string;
  /** Read the provider set. A rejection keeps the last set. */
  loadProviders?: () => Promise<CacheProvider[]>;
  payerSeed: Uint8Array;
  /** For tests. */
  fetch?: typeof fetch;
  /** Where measurements persist across page loads. Default: localStorage. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

/** The cache nodes of a provider set, what this host measured of them, and the payer. */
export class CacheNodes {
  readonly payer: { secret: Uint8Array; id: string };
  private readonly options: CacheNodesOptions;
  private readonly quality = new Map<string, CacheQuality>();
  private known: { providers: CacheProvider[]; at: number } | null = null;
  private reads = 0;
  private transfers = 0;
  // The provider that downloads each torrent file for this page, by content id. Each read asks it first, so the
  // progress is that of one download.
  private readonly torrentProviders = new Map<string, string>();
  // The jobs that receive a torrent file from a provider, by content id.
  private readonly receiving = new Map<string, TorrentJob>();

  constructor(options: CacheNodesOptions) {
    this.options = options;
    this.payer = payerFromSeed(options.payerSeed);
    this.loadQuality();
  }

  /** The provider set, read again after PROVIDERS_TTL_MS. A failed read keeps the last set. */
  async providers(): Promise<CacheProvider[]> {
    const now = Date.now();
    if (this.known && now - this.known.at < PROVIDERS_TTL_MS) {
      return this.known.providers;
    }
    try {
      const { loadProviders, providersUrl } = this.options;
      if (loadProviders !== undefined) {
        this.known = { providers: await loadProviders(), at: now };
      } else if (providersUrl !== undefined) {
        const response = await this.fetch(providersUrl, { signal: AbortSignal.timeout(NODE_TIMEOUT_MS) });
        if (response.ok) {
          this.known = { providers: parseProviders(await response.json()), at: now };
        }
      }
    } catch (err) {
      // Keep the last provider set. A read without providers goes to Bulletin.
      log.warn('[cache] the provider set is unavailable:', err);
    }
    return this.known?.providers ?? [];
  }

  // `fetch` of the options, else the global `fetch` at the time of the call.
  private fetch(input: string, init?: RequestInit): Promise<Response> {
    return (this.options.fetch ?? globalThis.fetch)(input, init);
  }

  /** The measurements of each provider, for display. */
  measurements(): ReadonlyMap<string, CacheQuality> {
    return this.quality;
  }

  /**
   * Read `key`, whose CID is `cid`, through the providers in quality order, or through the provider `only`. The first
   * provider that sends bytes with the right hash serves the read, and gets a receipt.
   */
  async read(key: Uint8Array, cid: string, options: { only?: string } = {}): Promise<CacheRead> {
    const all = await this.providers();
    const homes = homeNodes(
      cid,
      all.map(provider => provider.id),
    );
    const explore = this.reads++ % EXPLORE_EVERY === EXPLORE_EVERY - 1;
    let ordered = orderProviders(all, homes, this.quality, explore, Date.now());
    if (options.only !== undefined) {
      ordered = ordered.filter(provider => provider.id === options.only);
    }
    const attempts: CacheAttempt[] = [];
    for (const [rank, provider] of ordered.entries()) {
      const started = Date.now();
      const measured = this.measure(provider.id);
      const transfer = this.transferId();
      let response: Response;
      try {
        response = await this.ask(provider, cid, transfer);
      } catch (error) {
        measured.failures += 1;
        measured.failedAt = Date.now();
        attempts.push({ provider, outcome: 'failed', reason: String(error), ms: Date.now() - started });
        continue;
      }
      const ms = Date.now() - started;
      if (response.status === 404) {
        attempts.push({ provider, outcome: 'miss', ms });
        continue;
      }
      if (!response.ok) {
        const reason = `${String(response.status)}: ${(await response.text().catch(() => '')).slice(0, 200)}`;
        // A provider that refuses the payer did not fail.
        if (response.status !== 402) {
          measured.failures += 1;
          measured.failedAt = Date.now();
        }
        attempts.push({ provider, outcome: response.status === 402 ? 'refused' : 'failed', reason, ms });
        continue;
      }
      const value = new Uint8Array(await response.arrayBuffer());
      if (compare(blake2b(value, { dkLen: 32 }), key) !== 0) {
        measured.failures += 1;
        measured.failedAt = Date.now();
        attempts.push({ provider, outcome: 'bad-bytes', ms: Date.now() - started });
        continue;
      }
      const latency = Date.now() - started;
      measured.latencyMs =
        measured.latencyMs === undefined ? latency : Math.floor((measured.latencyMs * 7 + latency * 3) / 10);
      measured.successes += 1;
      delete measured.failedAt;
      this.saveQuality();
      attempts.push({ provider, outcome: 'served', ms: latency });
      this.pay(provider, cid, transfer);
      return { value, served: servedFrom(response, provider, rank, homes.includes(provider.id)), attempts };
    }
    this.saveQuality();
    return { attempts };
  }

  /**
   * Read one file of the torrent of `magnet` through the providers in quality order, or through the provider `only`.
   * The file is `file`, else `so=` of the link, else file 0. A provider sends the span of the file. The host checks the
   * info dict of the provider against the infohash and each piece against the info dict, and only then pays. A torrent
   * read does not change the latency that the host measured, because the time of the swarm is not the provider's.
   */
  async readTorrent(magnet: string, file?: number, options: { only?: string } = {}): Promise<CacheTorrentRead> {
    const ref = parseMagnet(magnet);
    const selected = file ?? ref.file ?? 0;
    const contentId = torrentId(ref.infoHash, selected);
    const all = await this.providers();
    const homes = homeNodes(
      contentId,
      all.map(provider => provider.id),
    );
    let ordered = orderProviders(all, homes, this.quality, false, Date.now());
    if (options.only !== undefined) {
      ordered = ordered.filter(provider => provider.id === options.only);
    }
    const downloading = this.torrentProviders.get(contentId);
    const index = ordered.findIndex(provider => provider.id === downloading);
    if (index > 0) {
      ordered.unshift(...ordered.splice(index, 1));
    }
    const reference = { source: magnet, cid: null, size: null, file: selected };
    const attempts: CacheAttempt[] = [];
    // A job receives the file now: wait for it. When it failed, the read asks the providers again.
    const running = this.receiving.get(contentId);
    if (running !== undefined) {
      const answer = await this.awaitTorrent(running, attempts, selected, contentId);
      if (answer !== undefined) {
        return answer;
      }
      ordered = ordered.filter(provider => provider.id !== running.provider.id);
    }
    for (const [rank, provider] of ordered.entries()) {
      const started = Date.now();
      const measured = this.measure(provider.id);
      // 1. The provider starts the download in the background, or says how far it is. A read waits only for a
      // provider that has the file.
      let progress: NodeProgress;
      try {
        const prefetch = await this.ask(
          provider,
          contentId,
          this.transferId(),
          reference,
          NODE_TIMEOUT_MS,
          '/prefetch',
        );
        if (!prefetch.ok) {
          const reason = `${String(prefetch.status)}: ${(await prefetch.text().catch(() => '')).slice(0, 300)}`;
          attempts.push({
            provider,
            outcome: prefetch.status === 402 ? 'refused' : 'failed',
            reason,
            ms: Date.now() - started,
          });
          continue;
        }
        progress = (await prefetch.json()) as NodeProgress;
      } catch (error) {
        measured.failures += 1;
        measured.failedAt = Date.now();
        attempts.push({ provider, outcome: 'failed', reason: String(error), ms: Date.now() - started });
        continue;
      }
      if (progress.state === 'failed') {
        this.torrentProviders.delete(contentId);
        attempts.push({ provider, outcome: 'failed', reason: progress.error ?? 'failed', ms: Date.now() - started });
        continue;
      }
      if (progress.state !== 'done') {
        this.torrentProviders.set(contentId, provider.id);
        const state: CacheTorrentState = ['metadata', 'downloading', 'importing'].includes(progress.state)
          ? (progress.state as CacheTorrentState)
          : 'starting';
        const running: CacheTorrentProgress = {
          provider,
          state,
          downloaded: progress.downloaded,
          peers: progress.peers,
          elapsedMs: progress.elapsed_ms,
        };
        if (progress.name !== undefined) {
          running.name = progress.name;
        }
        if (progress.size !== undefined) {
          running.size = progress.size;
        }
        return { attempts, file: selected, contentId, progress: running };
      }
      this.torrentProviders.delete(contentId);

      // 2. The provider has the file. The host receives it and checks it in the background, because a large file takes
      // longer than one call can wait.
      const job = this.receiveTorrent(provider, rank, homes, contentId, reference, ref.infoHash, selected);
      this.receiving.set(contentId, job);
      const answer = await this.awaitTorrent(job, attempts, selected, contentId);
      if (answer !== undefined) {
        return answer;
      }
    }
    this.saveQuality();
    return { attempts, file: selected, contentId };
  }

  private measure(id: string): CacheQuality {
    let measured = this.quality.get(id);
    if (!measured) {
      measured = { successes: 0, failures: 0 };
      this.quality.set(id, measured);
    }
    return measured;
  }

  // A new transfer id for each request to a node: a node serves a transfer id once, and the ledger charges it once.
  private transferId(): string {
    this.transfers += 1;
    return `dotli-${String(Date.now())}-${String(this.transfers)}-${toHex(crypto.getRandomValues(new Uint8Array(4)))}`;
  }

  // Receive a torrent file from a provider that has it, check it against the torrent and pay for it. The job counts
  // the bytes that came, for the progress.
  private receiveTorrent(
    provider: CacheProvider,
    rank: number,
    homes: string[],
    contentId: string,
    reference: object,
    infoHash: string,
    selected: number,
  ): TorrentJob {
    const job: TorrentJob = { provider, started: Date.now(), received: 0, done: Promise.resolve() };
    const run = async (): Promise<TorrentJobResult> => {
      const started = job.started;
      const measured = this.measure(provider.id);
      const transfer = this.transferId();
      let response: Response;
      let span: Uint8Array;
      try {
        response = await this.ask(provider, contentId, transfer, reference, TORRENT_TIMEOUT_MS);
        if (!response.ok) {
          const reason = `${String(response.status)}: ${(await response.text().catch(() => '')).slice(0, 300)}`;
          const outcome: CacheOutcome =
            response.status === 404 ? 'miss' : response.status === 402 ? 'refused' : 'failed';
          return { attempt: { provider, outcome, reason, ms: Date.now() - started } };
        }
        span = await readBody(response, job);
      } catch (error) {
        measured.failures += 1;
        measured.failedAt = Date.now();
        return { attempt: { provider, outcome: 'failed', reason: String(error), ms: Date.now() - started } };
      }
      let checked: { value: Uint8Array; name: string; files: TorrentListedFile[] };
      try {
        const info = await this.fetch(`${provider.api}/torrent/${infoHash}`, {
          signal: AbortSignal.timeout(NODE_TIMEOUT_MS),
        });
        if (!info.ok) {
          throw new Error(`no info dict: ${String(info.status)}`);
        }
        checked = await verifySpan(new Uint8Array(await info.arrayBuffer()), infoHash, selected, span);
      } catch (error) {
        measured.failures += 1;
        measured.failedAt = Date.now();
        return { attempt: { provider, outcome: 'bad-bytes', reason: String(error), ms: Date.now() - started } };
      }
      measured.successes += 1;
      delete measured.failedAt;
      this.saveQuality();
      const attempt: CacheAttempt = { provider, outcome: 'served', ms: Date.now() - started };
      this.pay(provider, contentId, transfer);
      const served = servedFrom(response, provider, rank, homes.includes(provider.id));
      return { attempt, value: checked.value, name: checked.name, files: checked.files, served };
    };
    job.done = run().then(
      result => {
        job.result = result;
      },
      (error: unknown) => {
        job.result = { attempt: { provider, outcome: 'failed', reason: String(error), ms: Date.now() - job.started } };
      },
    );
    return job;
  }

  // Wait a short time for a receive job. A small file comes in that time. Gives the read when the job is done, a
  // progress while it runs, or nothing when it failed: the attempt then goes into `attempts`.
  private async awaitTorrent(
    job: TorrentJob,
    attempts: CacheAttempt[],
    file: number,
    contentId: string,
  ): Promise<CacheTorrentRead | undefined> {
    await Promise.race([job.done, new Promise(resolve => setTimeout(resolve, RECEIVE_WAIT_MS))]);
    const result = job.result;
    if (result === undefined) {
      const progress: CacheTorrentProgress = {
        provider: job.provider,
        state: 'receiving',
        downloaded: job.received,
        peers: 0,
        elapsedMs: Date.now() - job.started,
      };
      if (job.size !== undefined) {
        progress.size = job.size;
      }
      return { attempts, file, contentId, progress };
    }
    this.receiving.delete(contentId);
    attempts.push(result.attempt);
    this.saveQuality();
    if (result.value === undefined) {
      return undefined;
    }
    return {
      value: result.value,
      name: result.name,
      files: result.files,
      served: result.served,
      attempts,
      file,
      contentId,
    };
  }

  /**
   * The account of the payer at the provider `only`, or at the first provider in quality order. The provider gives the
   * quote of its ledger. A ledger without allowances gives only `balance`, which is then all paid.
   */
  async account(options: { only?: string } = {}): Promise<CacheAccount> {
    const ordered = orderProviders(await this.providers(), [], this.quality, false, Date.now());
    const provider = options.only === undefined ? ordered[0] : ordered.find(candidate => candidate.id === options.only);
    if (provider === undefined) {
      throw new Error(
        options.only === undefined
          ? 'no cache providers'
          : `the cache provider ${options.only} is not in the provider set`,
      );
    }
    const response = await this.fetch(`${provider.api}/account/${this.payer.id}`, {
      signal: AbortSignal.timeout(NODE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`${String(response.status)}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
    }
    const quote = (await response.json()) as Record<string, unknown>;
    const count = (name: string): number => (typeof quote[name] === 'number' ? quote[name] : 0);
    return {
      payer: this.payer.id,
      provider,
      allowance: count('allowance'),
      allowanceRetention: count('allowance_retention'),
      paid: typeof quote['paid'] === 'number' ? quote['paid'] : count('balance'),
      allowancePerDay: count('allowance_per_day'),
      retentionAllowancePerDay: count('retention_allowance_per_day'),
      readPrice: count('price'),
      retentionPrice: count('retention_price'),
    };
  }

  /**
   * The provider to keep `contentId`: the provider `only`, else the first in quality order, with the home nodes of the
   * content first. A pin on a home node serves the reads of other hosts too, as they ask the home nodes first.
   */
  async retentionProvider(contentId: string, only?: string): Promise<CacheProvider> {
    const all = await this.providers();
    const homes = homeNodes(
      contentId,
      all.map(provider => provider.id),
    );
    const ordered = orderProviders(all, homes, this.quality, false, Date.now());
    const provider = only === undefined ? ordered[0] : ordered.find(candidate => candidate.id === only);
    if (provider === undefined) {
      throw new CacheRetainError(
        'failed',
        only === undefined ? 'no cache providers' : `the cache provider ${only} is not in the provider set`,
      );
    }
    return provider;
  }

  /**
   * Pay `provider` in advance to keep the Bulletin preimage `cid` of `size` bytes for `periodSecs` from now. For a
   * chunked file, `cid` is the manifest and `size` the size of the manifest and all its chunks. The provider then keeps
   * the chunks too. A retention that a previous one covers costs 0.
   */
  async retain(provider: CacheProvider, cid: string, size: number, periodSecs: number): Promise<CacheRetention> {
    const from = Math.floor(Date.now() / 1000);
    const until = from + periodSecs;
    const fields = { transfer: this.transferId(), payer: this.payer.id, provider: provider.id, content: cid };
    const signature = toHex(sign(this.payer.secret, retentionMessage({ ...fields, size, from, until })));
    const body = {
      reference: { source: `bulletin:${cid}`, cid: null, size },
      authorization: { receipt: { ...fields, service: 'Retention', size, from, until }, signature },
    };
    const response = await this.fetch(`${provider.api}/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PIN_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw pinError(response.status, (await response.text().catch(() => '')).slice(0, 300));
    }
    const reply = (await response.json()) as Record<string, unknown>;
    const count = (name: string): number => (typeof reply[name] === 'number' ? reply[name] : 0);
    return { provider, until: count('until'), size: count('size'), chunks: count('chunks'), charged: count('charged') };
  }

  // Ask one provider for content `content` with a read request that the payer signs. The default reference is the
  // Bulletin preimage of the CID `content`.
  private ask(
    provider: CacheProvider,
    content: string,
    transfer: string,
    reference: object = { source: `bulletin:${content}`, cid: null, size: null },
    timeoutMs = NODE_TIMEOUT_MS,
    path = '/acquire',
  ): Promise<Response> {
    const request = {
      transfer,
      payer: this.payer.id,
      provider: provider.id,
      content,
      issued_at: Math.floor(Date.now() / 1000),
    };
    const message = readMessage({ ...request, issuedAt: request.issued_at });
    const body = { reference, read: { request, signature: toHex(sign(this.payer.secret, message)) } };
    return this.fetch(`${provider.api}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  // Sign the receipt for a checked delivery and send it to the provider that served it. The read does not wait.
  private pay(provider: CacheProvider, cid: string, transfer: string): void {
    const fields = { transfer, payer: this.payer.id, provider: provider.id, content: cid };
    const receipt = { ...fields, service: 'Delivery', size: 0, from: 0, until: 0 };
    const signature = toHex(sign(this.payer.secret, receiptMessage(fields)));
    void this.fetch(`${provider.api}/receipt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receipt, signature }),
      signal: AbortSignal.timeout(NODE_TIMEOUT_MS),
    }).catch(() => undefined);
  }

  private storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
    if (this.options.storage !== undefined) {
      return this.options.storage;
    }
    try {
      return globalThis.localStorage;
    } catch {
      // localStorage can be unavailable (private mode, sandbox): the measurements then last for this page.
      return null;
    }
  }

  private loadQuality(): void {
    try {
      const stored = JSON.parse(this.storage()?.getItem(QUALITY_KEY) ?? '{}') as Record<string, CacheQuality>;
      for (const [id, measured] of Object.entries(stored)) {
        const kept: CacheQuality = { successes: measured.successes, failures: measured.failures };
        if (measured.latencyMs !== undefined) {
          kept.latencyMs = measured.latencyMs;
        }
        this.quality.set(id, kept);
      }
      // eslint-disable-next-line no-restricted-syntax -- measurements from an older build that do not parse; the host starts again.
    } catch {
      // Start with no measurements.
    }
  }

  private saveQuality(): void {
    const kept: Record<string, Omit<CacheQuality, 'failedAt'>> = {};
    for (const [id, measured] of this.quality) {
      const entry: Omit<CacheQuality, 'failedAt'> = { successes: measured.successes, failures: measured.failures };
      if (measured.latencyMs !== undefined) {
        entry.latencyMs = measured.latencyMs;
      }
      kept[id] = entry;
    }
    try {
      this.storage()?.setItem(QUALITY_KEY, JSON.stringify(kept));
      // eslint-disable-next-line no-restricted-syntax -- no storage (quota, private mode); the measurements last for this page only.
    } catch {
      // Keep the measurements in memory.
    }
  }
}
