// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Cache nodes keep verified copies of Bulletin preimages near their users and serve them faster than Bulletin. A read
// asks the providers of the provider set in quality order, each with a read request that the payer signs. It checks the
// bytes against the key, and only then pays the provider that served, with a signed receipt. A provider that sends bad
// bytes gets no receipt. The messages are those of the cache prototype (cache/src/payment.rs) and of the CLI host
// (truapi-host-cli, cache_lookup.rs). The three share test vectors.
//
// The provider order: providers that failed in the last 30 s go last. The others go by the latency measured here, a
// moving average with a prior of 50 ms. The content's home nodes count at half their latency: the 3 providers that rank
// highest by blake2b-256(CID || endpoint id), the rank that the cache nodes use too. Every fourth read tries an
// unmeasured provider first.

import { blake2b } from '@noble/hashes/blake2.js';
import { getPublicKey, secretFromSeed, sign } from '@scure/sr25519';
import { log } from '@dotli/shared';

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
}

/** The result of one read: the value when a provider had it, and every attempt. */
export interface CacheRead {
  value?: Uint8Array;
  served?: CacheServed;
  attempts: CacheAttempt[];
}

/** What the host measured of one provider. */
export interface CacheQuality {
  latencyMs?: number;
  successes: number;
  failures: number;
  /** Not kept across page loads: a recent failure should not outlive the page. */
  failedAt?: number;
}

export const CACHE_HOMES = 3;
const FAILURE_COOLDOWN_MS = 30_000;
const PRIOR_MS = 50;
const EXPLORE_EVERY = 4;
const NODE_TIMEOUT_MS = 15_000;
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

// The fields that a receipt and a read request share, after the prefix: the transfer id, the payer and provider keys
// (32 raw bytes each) and the content id. Text fields have a u32 LE length first.
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

/** A payer from a 32-byte seed, expanded the way Substrate expands an sr25519 mini secret key. */
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

/** The order in which to ask `providers` for content whose home nodes are `homes`. */
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

/** `local`, `source`, or `peer:<64 hex>` from the `x-cache-origin` header. Anything else is unknown. */
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
  /** Where the provider set is: a node's `GET /providers`, or a static JSON file of the same shape. */
  providersUrl: string;
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
      const response = await this.fetch(this.options.providersUrl, { signal: AbortSignal.timeout(NODE_TIMEOUT_MS) });
      if (response.ok) {
        this.known = { providers: parseProviders(await response.json()), at: now };
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
        // A provider that the payer cannot pay is not a failing provider.
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
      const elapsed = Number(response.headers.get('x-cache-elapsed-ms'));
      const served: CacheServed = {
        provider,
        origin: parseOrigin(response.headers.get('x-cache-origin')),
        rank,
        home: homes.includes(provider.id),
      };
      if (Number.isFinite(elapsed) && response.headers.has('x-cache-elapsed-ms')) {
        served.providerMs = elapsed;
      }
      const trace = response.headers.get('x-cache-trace');
      if (trace !== null && trace !== '') {
        served.trace = trace;
      }
      return { value, served, attempts };
    }
    this.saveQuality();
    return { attempts };
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

  private ask(provider: CacheProvider, cid: string, transfer: string): Promise<Response> {
    const request = {
      transfer,
      payer: this.payer.id,
      provider: provider.id,
      content: cid,
      issued_at: Math.floor(Date.now() / 1000),
    };
    const message = readMessage({ ...request, issuedAt: request.issued_at });
    const body = {
      reference: { source: `bulletin:${cid}`, cid: null, size: null },
      read: { request, signature: toHex(sign(this.payer.secret, message)) },
    };
    return this.fetch(`${provider.api}/acquire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NODE_TIMEOUT_MS),
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
