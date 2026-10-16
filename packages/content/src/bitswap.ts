// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isResponse } from '@polkadot-api/json-rpc-provider';
import type { JsonRpcConnection, JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import { hexToBytes } from '@noble/hashes/utils.js';
import { CHAIN_HALTED_ERROR_DATA, createRemoteChainProvider, isRemoteChainSupported } from '@dotli/protocol';
import { isSandboxOrigin, getBackend, getActiveServicesConfig } from '@dotli/config';

import { errorName, log, serializeError } from '@dotli/shared';

import { CONTENT_ERRORS, named } from './errors.js';

// `bitswap_v1_get` error codes. Anything else, an invalid CID included, is terminal.
const ERR_FAIL = -32810;
const ERR_FAIL_RETRY = -32811;
const ERR_FAIL_BACKOFF = -32812;

/** Every sandbox block passes here. The root's link `Tsize` sum gives the total up front, so progress is real. */
export interface ContentProgress {
  bytesFetched: number;
  totalBytes: number | null;
  bytesPerSecond: number;
}

type ProgressCallback = (progress: ContentProgress) => void;
// A set, because the resolution trace and the loading bar both listen.
const progressCallbacks = new Set<ProgressCallback>();
let bytesFetched = 0;
let totalBytes: number | null = null;
let firstBlockAt = 0;

export function onContentProgress(cb: ProgressCallback): () => void {
  progressCallbacks.add(cb);
  return () => {
    progressCallbacks.delete(cb);
  };
}

function readDagTotal(bytes: Uint8Array): number | null {
  try {
    // Hand-decoded so the 40kB `@ipld/dag-pb` decoder stays out of the eager host bundle.
    // Links are field 2, and each carries Tsize as varint field 3.
    let i = 0;
    let total = 0;
    let sawLink = false;
    const readVarint = (): number => {
      let result = 0;
      let shift = 0;
      for (const b of bytes.subarray(i)) {
        i += 1;
        result += (b & 0x7f) * 2 ** shift;
        if ((b & 0x80) === 0) {
          break;
        }
        shift += 7;
      }
      return result;
    };
    while (i < bytes.length) {
      const key = readVarint();
      const field = key >> 3;
      const wire = key & 0x7;
      if (wire !== 2) {
        return null;
      }
      const len = readVarint();
      if (field === 2) {
        const end = i + len;
        while (i < end) {
          const lk = readVarint();
          const lf = lk >> 3;
          const lw = lk & 0x7;
          if (lw === 0) {
            const v = readVarint();
            if (lf === 3) {
              total += v;
              sawLink = true;
            }
          } else if (lw === 2) {
            // `i += readVarint()` would read `i` before the call advanced it.
            const skip = readVarint();
            i += skip;
          } else {
            return null;
          }
        }
        i = end;
      } else {
        i += len;
      }
    }
    return sawLink ? total : null;
  } catch {
    return null;
  }
}

function noteBlock(bytes: Uint8Array): void {
  if (firstBlockAt === 0) {
    firstBlockAt = performance.now();
    totalBytes = readDagTotal(bytes);
  }
  bytesFetched += bytes.length;
  const elapsed = performance.now() - firstBlockAt;
  const progress = {
    bytesFetched,
    totalBytes,
    bytesPerSecond: elapsed > 0 ? (bytesFetched / elapsed) * 1000 : 0,
  };
  for (const cb of progressCallbacks) {
    cb(progress);
  }
}
/** Marks a local abort by name, since any numeric code outside the JSON-RPC reserved range could be the chain's. */
const ABORT_ERROR_NAME = 'AbortError';

const PER_CALL_TIMEOUT_MS = 60_000;
const TOTAL_BUDGET_MS = 180_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 5_000;

// smoldot calls -32810 permanent, but it only means the peers connected at that instant lacked the block,
// so a retry meets a larger set. Counted in attempts, not time, which slow -32812 runs would drain.
const DISCOVERY_RETRIES = 8;

interface PendingResolver {
  resolve: (bytes: Uint8Array) => void;
  reject: (err: Error) => void;
}

let nextId = 1;
const pending = new Map<number, PendingResolver>();

let connection: JsonRpcConnection | null = null;

function ensureConnection(): JsonRpcConnection {
  if (connection !== null) {
    return connection;
  }
  const bulletinGenesis = getActiveServicesConfig().bulletin.genesis;
  const provider = createRemoteChainProvider(bulletinGenesis);
  if (provider === null) {
    throw named(
      new Error(`Bulletin Paseo (${bulletinGenesis}) is not in the supported chain set`),
      CONTENT_ERRORS.BITSWAP_UNAVAILABLE,
    );
  }
  const opened = provider(
    (message: JsonRpcMessage) => {
      if (!isResponse(message)) {
        return;
      }
      if (typeof message.id !== 'number') {
        return;
      }
      const entry = pending.get(message.id);
      if (entry === undefined) {
        return;
      }
      pending.delete(message.id);
      if ('error' in message) {
        const err = named(
          new Error(`bitswap_v1_get failed (code=${String(message.error.code)}): ${message.error.message}`),
          CONTENT_ERRORS.BITSWAP_RPC,
        );
        // A halt answer arrives before `onHalt` drops the connection, so the retry redials a rebuilt chain.
        const halted = message.error.data === CHAIN_HALTED_ERROR_DATA;
        (err as { code?: number }).code = halted ? ERR_FAIL_RETRY : message.error.code;
        entry.reject(err);
        return;
      }
      if (typeof message.result !== 'string') {
        entry.reject(
          named(
            new Error(`bitswap_v1_get: expected hex string result, got ${typeof message.result}`),
            CONTENT_ERRORS.BITSWAP_RPC,
          ),
        );
        return;
      }
      // Parsed once here, so the sandbox gets a transferred buffer instead of a cloned hex string.
      const hex = message.result;
      const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
      entry.resolve(hexToBytes(stripped));
    },
    reason => {
      // The next attempt redials. Requests the halt never answered are rejected here, and a halt from a
      // replaced connection must not touch its successor.
      if (connection !== opened) {
        return;
      }
      connection = null;
      for (const [id, entry] of pending) {
        pending.delete(id);
        const err = named(new Error('Bulletin connection halted'), CONTENT_ERRORS.BITSWAP_CONNECTION);
        // A halted chain is rebuilt on reconnect, so it is retried. A dead frame is fatal.
        if (reason === 'chain') {
          (err as { code?: number }).code = ERR_FAIL_RETRY;
        }
        entry.reject(err);
      }
    },
  );
  connection = opened;
  return opened;
}

function errorCode(err: unknown): number | null {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number') {
      return code;
    }
  }
  return null;
}

function abortError(cid: string): Error {
  const err = new Error(`bitswap_v1_get(${cid}): aborted`);
  err.name = ABORT_ERROR_NAME;
  return err;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // `addEventListener` never fires on a signal that is already aborted.
    if (signal?.aborted === true) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Fetch one block via the protocol iframe's smoldot.
 * Pass `signal` from anything that can be torn down, since a retrying call runs for the full budget.
 */
export async function bitswapGet(cid: string, signal?: AbortSignal): Promise<Uint8Array> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let discoveryAttempts = 0;
  let transientAttempts = 0;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw named(
        new Error(
          `bitswap_v1_get(${cid}): timed out after ${String(TOTAL_BUDGET_MS)}ms (${String(attempt - 1)} attempts made)`,
        ),
        CONTENT_ERRORS.BITSWAP_TIMEOUT,
      );
    }
    const callTimeout = Math.min(PER_CALL_TIMEOUT_MS, remaining);
    try {
      return await sendOnce(cid, callTimeout, signal);
    } catch (err) {
      const code = errorCode(err);

      // Separate counters, so early -32812s cannot pin discovery retries at the backoff cap.
      let backoffAttempt: number;
      if (code === ERR_FAIL) {
        discoveryAttempts += 1;
        if (discoveryAttempts > DISCOVERY_RETRIES) {
          throw Object.assign(
            named(
              new Error(
                `bitswap_v1_get(${cid}): provider discovery exhausted after ${String(discoveryAttempts)} failures (${String(attempt)} attempts made): ${serializeError(err)}`,
              ),
              CONTENT_ERRORS.BITSWAP_NOT_FOUND,
            ),
            { code },
          );
        }
        backoffAttempt = discoveryAttempts;
      } else if (code === ERR_FAIL_RETRY || code === ERR_FAIL_BACKOFF) {
        transientAttempts += 1;
        backoffAttempt = transientAttempts;
      } else {
        throw err;
      }

      // The 1ms floor keeps a nearly spent budget off a zero delay. The deadline check then ends the call.
      const delay = Math.min(
        BACKOFF_CAP_MS,
        BACKOFF_BASE_MS * 2 ** Math.min(backoffAttempt - 1, 4),
        Math.max(1, deadline - Date.now()),
      );
      log.warn(
        `[dot.li bitswap] ${cid} retry attempt=${String(attempt)} code=${String(code)} delay=${String(delay)}ms`,
      );
      try {
        await sleep(delay, signal);
      } catch {
        throw abortError(cid);
      }
    }
  }
}

function sendOnce(cid: string, timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array> {
  const id = nextId++;
  const conn = ensureConnection();
  return new Promise<Uint8Array>((resolve, reject) => {
    // `addEventListener` never fires on a signal that is already aborted.
    if (signal?.aborted === true) {
      reject(abortError(cid));
      return;
    }
    // Every exit shares one teardown, since the caller's signal outlives the call and would collect listeners.
    const cleanup = (): void => {
      clearTimeout(timer);
      pending.delete(id);
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      const err = named(
        new Error(`bitswap_v1_get(${cid}): per-call timed out after ${String(timeoutMs)}ms`),
        CONTENT_ERRORS.BITSWAP_TIMEOUT,
      );
      (err as { code?: number }).code = ERR_FAIL_RETRY;
      cleanup();
      reject(err);
    }, timeoutMs);
    // smoldot cannot cancel an issued request, so the entry is dropped and its late reply finds no slot.
    function onAbort(): void {
      cleanup();
      reject(abortError(cid));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(id, {
      resolve: bytes => {
        cleanup();
        resolve(bytes);
      },
      reject: err => {
        cleanup();
        reject(err);
      },
    });
    conn.send({
      jsonrpc: '2.0',
      id,
      method: 'bitswap_v1_get',
      params: [cid],
    });
  });
}

interface BitswapGetMessage {
  type: 'dotli:bitswap-get';
  id: string;
  cid: string;
}

interface BitswapAbortMessage {
  type: 'dotli:bitswap-abort';
  ids: string[];
}

interface BitswapResultOk {
  type: 'dotli:bitswap-result';
  id: string;
  ok: true;
  bytes: Uint8Array;
}

interface BitswapResultErr {
  type: 'dotli:bitswap-result';
  id: string;
  ok: false;
  error: string;
  /** So the sandbox rebuilds the same exception type. */
  errorName?: string;
  code?: number;
}

function isBitswapGetMessage(value: unknown): value is BitswapGetMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    obj['type'] === 'dotli:bitswap-get' &&
    typeof obj['id'] === 'string' &&
    typeof obj['cid'] === 'string' &&
    obj['id'].length > 0 &&
    obj['cid'].length > 0
  );
}

function isBitswapAbortMessage(value: unknown): value is BitswapAbortMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    obj['type'] === 'dotli:bitswap-abort' && Array.isArray(obj['ids']) && obj['ids'].every(id => typeof id === 'string')
  );
}

export interface BlockCache {
  /** Must return a fresh copy, since the relay transfers the buffer to the sandbox and detaches it. */
  get: (cid: string) => Promise<Uint8Array | null>;
  put: (cid: string, bytes: Uint8Array) => Promise<void>;
  delete: (cid: string) => Promise<void>;
}

export interface SandboxBitswapOptions {
  blockCache?: BlockCache;
  onBlockServed?: (from: 'cache' | 'network') => void;
}

interface ServedBlock {
  bytes: Uint8Array;
  from: 'cache' | 'network';
}

async function blockMatches(cid: string, bytes: Uint8Array): Promise<boolean> {
  let blockMatchesCid: (cid: string, bytes: Uint8Array) => boolean;
  try {
    ({ blockMatchesCid } = await import('./verify.js'));
  } catch (err) {
    // Fail closed. A cached block then falls back to the network, and a fetched one is served but not cached.
    log.warn(`[dot.li bitswap-relay] verifier import failed for ${cid}: ${serializeError(err)}`);
    return false;
  }
  return blockMatchesCid(cid, bytes);
}

async function readCachedBlock(cache: BlockCache, cid: string): Promise<Uint8Array | null> {
  let bytes: Uint8Array | null;
  try {
    bytes = await cache.get(cid);
  } catch (err) {
    log.warn(`[dot.li bitswap-relay] block cache read failed for ${cid}: ${serializeError(err)}`);
    return null;
  }
  if (bytes === null) {
    return null;
  }
  if (await blockMatches(cid, bytes)) {
    return bytes;
  }
  // Corrupted on disk. Drop it so the network copy takes its place.
  void cache.delete(cid).catch((err: unknown) => {
    log.warn(`[dot.li bitswap-relay] block cache delete failed: ${serializeError(err)}`);
  });
  return null;
}

async function serveBlock(cid: string, signal: AbortSignal, cache: BlockCache | undefined): Promise<ServedBlock> {
  if (cache !== undefined) {
    const cached = await readCachedBlock(cache, cid);
    if (cached !== null) {
      return { bytes: cached, from: 'cache' };
    }
  }
  const bytes = await bitswapGet(cid, signal);
  if (cache !== undefined && (await blockMatches(cid, bytes))) {
    // The reply detaches `bytes.buffer` before the IndexedDB write clones it.
    void cache.put(cid, bytes.slice()).catch((err: unknown) => {
      log.warn(`[dot.li bitswap-relay] block cache write failed: ${serializeError(err)}`);
    });
  }
  return { bytes, from: 'network' };
}

/**
 * Live fetches per frame, then per id, so a sandbox can abort its own on `pagehide`.
 * Keyed by frame because every product shares the sandbox origin and ids restart at 1 in each frame.
 */
const inFlight = new Map<MessageEventSource, Map<string, AbortController>>();
let relayInstalled = false;

/** Idempotent. Returns a function that removes the relay. */
export function listenForSandboxBitswap(options: SandboxBitswapOptions = {}): () => void {
  if (relayInstalled) {
    return () => {
      /* the first caller owns the relay */
    };
  }
  relayInstalled = true;
  if (getBackend() === 'rpc-gateway') {
    log.debug('[dot.li bitswap-relay] Bitswap is unavailable in RPC gateway mode; sandbox bitswap requests will fail.');
  } else if (!isRemoteChainSupported(getActiveServicesConfig().bulletin.genesis)) {
    log.warn('[dot.li bitswap-relay] Bulletin not in supported chain set; sandbox bitswap requests will fail.');
  }
  const onMessage = (event: MessageEvent): void => {
    const data: unknown = event.data;
    if (isBitswapAbortMessage(data)) {
      if (!isSandboxOrigin(event.origin) || event.source === null) {
        return;
      }
      // Only this frame's own fetches, so one product cannot cancel another's.
      const own = inFlight.get(event.source);
      if (own === undefined) {
        return;
      }
      for (const id of data.ids) {
        own.get(id)?.abort();
        own.delete(id);
      }
      if (own.size === 0) {
        inFlight.delete(event.source);
      }
      return;
    }
    if (!isBitswapGetMessage(data)) {
      return;
    }
    if (!isSandboxOrigin(event.origin)) {
      log.warn(`[dot.li bitswap-relay] Rejected bitswap-get from non-sandbox origin: ${event.origin}`);
      return;
    }
    const source = event.source;
    if (source === null) {
      return;
    }
    const aborter = new AbortController();
    let own = inFlight.get(source);
    if (own === undefined) {
      own = new Map<string, AbortController>();
      inFlight.set(source, own);
    }
    own.set(data.id, aborter);
    void serveBlock(data.cid, aborter.signal, options.blockCache)
      .finally(() => {
        // A reused id must not have the earlier fetch's cleanup drop the newer entry.
        if (own.get(data.id) === aborter) {
          own.delete(data.id);
        }
        if (own.size === 0) {
          inFlight.delete(source);
        }
      })
      .then(({ bytes, from }) => {
        noteBlock(bytes);
        options.onBlockServed?.(from);
        const reply: BitswapResultOk = {
          type: 'dotli:bitswap-result',
          id: data.id,
          ok: true,
          bytes,
        };
        source.postMessage(reply, {
          targetOrigin: event.origin,
          transfer: [bytes.buffer as ArrayBuffer],
        });
      })
      .catch((err: unknown) => {
        const name = errorName(err);
        const code = errorCode(err);
        const reply: BitswapResultErr = {
          type: 'dotli:bitswap-result',
          id: data.id,
          ok: false,
          error: serializeError(err),
          ...(name !== undefined ? { errorName: name } : {}),
          ...(code !== null ? { code } : {}),
        };
        source.postMessage(reply, { targetOrigin: event.origin });
      });
  };
  window.addEventListener('message', onMessage);
  return () => {
    window.removeEventListener('message', onMessage);
    relayInstalled = false;
  };
}

export const __testing = { noteBlock };
