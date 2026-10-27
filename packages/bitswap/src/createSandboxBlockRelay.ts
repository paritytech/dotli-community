// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves a sandbox frame's block requests from the host. The sandbox runs no light client, and its credentialless
// origin loses its storage on every reload, so the host fetches and keeps the blocks.

import type { BitswapResultMessage, SandboxChannel } from '@dotli/sandbox-wire';
import { captureException, m, recordExpected, reportListener, spans as S } from '@dotli/metrics';
import { createListenerSet, getErrorName, log, setErrorName, serializeError } from '@dotli/shared';

import { readDagTotal } from './readDagTotal.js';
import { errorCode } from './errors.js';

/** Every served block passes here. The root's link `Tsize` sum gives the total up front, so progress is real. */
export type ContentProgress = {
  bytesFetched: number;
  totalBytes: number | null;
  bytesPerSecond: number;
};

export type BlockOrigin = 'cache' | 'network';

export type BlockCache = {
  /**
   * Must return a fresh copy, since the relay transfers the buffer to the sandbox and detaches it. Resolves null on a
   * miss and rejects when the store cannot be read.
   */
  get: (cid: string) => Promise<Uint8Array | null>;
  /** Stores the bytes under the CID. Rejects when the store cannot be written. */
  put: (cid: string, bytes: Uint8Array) => Promise<void>;
  /** Removes the CID's entry, and resolves when there is none. Rejects when the store cannot be written. */
  delete: (cid: string) => Promise<void>;
};

type Params = {
  /** Hands over only messages from a trusted sandbox origin. */
  channel: SandboxChannel;
  /** Fetches one block over the network. The signal aborts when the frame that asked goes away. */
  blocks: (cid: string, signal: AbortSignal) => Promise<Uint8Array>;
  /** Null when the settings skip the archive cache. */
  cache: BlockCache | null;
  /**
   * Whether the bytes hash to the CID. This relay is the one check of every block on its path. A rejection leaves the
   * answer unknown, so the block is not served or written, and a cached copy is kept for a verifier that loads later.
   * The verifier reports why it could not run.
   */
  verify: (cid: string, bytes: Uint8Array) => Promise<boolean>;
  /** The clock the transfer speed is measured on. */
  now?: () => number;
};

export type SandboxBlockRelay = ReturnType<typeof createSandboxBlockRelay>;

/** `unknown` when the verifier could not run, which says nothing about the bytes. */
type Verdict = { kind: 'match' } | { kind: 'mismatch' } | { kind: 'unknown'; cause: unknown };

type ServedBlock = {
  bytes: Uint8Array;
  from: BlockOrigin;
};

type RelayStep = 'verify' | 'cache_read' | 'cache_delete' | 'cache_write';

type ReportRelayFailureParams = {
  /** The relay step that failed. */
  step: RelayStep;
  /** What the step threw. */
  error: unknown;
  /** The block the step handled, when there was one. */
  cid?: string;
  /** The metric reason. The error's name when not given. */
  reason?: string;
};

/** A frame's id with its origin, or the window of a sandbox that sends no id. */
type FrameKey = MessageEventSource | string;

/** Where a block request or abort came from: the frame id the sandbox sent, if any, its origin and its window. */
type FrameAddress = {
  frame: string | undefined;
  origin: string;
  source: MessageEventSource | null;
};

/**
 * Spelled as `CONTENT_ERRORS.VERIFICATION`, which bitswap may not import. The sandbox branches on this name.
 */
const VERIFICATION_ERROR = 'ContentVerificationError';

/** Creates the host side of the sandbox's block channel, which serves, verifies and caches the blocks the sandbox asks for. */
export function createSandboxBlockRelay({ channel, blocks, cache, verify, now = () => performance.now() }: Params) {
  // A listener's throw must not fail a block the sandbox already got, nor keep the next listener from hearing it.
  const progressListeners = createListenerSet<ContentProgress>({
    onListenerError: reportListener('content', 'bitswap_relay.progress'),
  });
  const servedListeners = createListenerSet<BlockOrigin>({
    onListenerError: reportListener('content', 'bitswap_relay.served'),
  });
  /** The running load's count. A walk asks for its root first and only once, so the root asked again is a new load. */
  let load: { root: string; totalBytes: number | null; bytesFetched: number; startedAt: number } | null = null;
  /**
   * Live fetches per frame, then per id, so a sandbox can abort its own on `pagehide`. Keyed by frame because ids
   * restart at 1 in each frame. A frame is the id it sends together with its origin, since its abort arrives after it
   * is gone and without a source, and another product's sandbox may send the same id. A sandbox that sends no id is
   * keyed by its window.
   */
  const inFlight = new Map<FrameKey, Map<string, AbortController>>();
  function getFrameKey(address: FrameAddress & { source: MessageEventSource }): FrameKey;
  function getFrameKey(address: FrameAddress): FrameKey | null;
  function getFrameKey({ frame, origin, source }: FrameAddress): FrameKey | null {
    return frame === undefined ? source : `${origin} ${frame}`;
  }

  function noteBlock(cid: string, { bytes, from }: ServedBlock): void {
    // A retry in the sandbox, or a frame the host rendered again, walks from the root again and counts from zero.
    if (load === null || cid === load.root) {
      load = { root: cid, totalBytes: readDagTotal(bytes), bytesFetched: 0, startedAt: now() };
    }
    load.bytesFetched += bytes.length;
    const elapsed = now() - load.startedAt;
    progressListeners.emit({
      bytesFetched: load.bytesFetched,
      totalBytes: load.totalBytes,
      bytesPerSecond: elapsed > 0 ? (load.bytesFetched / elapsed) * 1000 : 0,
    });
    servedListeners.emit(from);
  }

  async function check(cid: string, bytes: Uint8Array): Promise<Verdict> {
    try {
      return (await verify(cid, bytes)) ? { kind: 'match' } : { kind: 'mismatch' };
    } catch (error) {
      // The verifier reported why it could not run, so each block it leaves unchecked is a breadcrumb and a count.
      recordExpected(error, { flow: 'content', step: 'relay_verify' });
      m.count(S.CONTENT_BLOCK_RELAY, { outcome: 'error', reason: getErrorName(error) ?? 'unknown', step: 'verify' });
      return { kind: 'unknown', cause: error };
    }
  }

  async function readCached(store: BlockCache, cid: string): Promise<Uint8Array | null> {
    let bytes: Uint8Array | null;
    try {
      bytes = await store.get(cid);
    } catch (error) {
      reportRelayFailure({ step: 'cache_read', error });
      return null;
    }
    if (bytes === null) {
      return null;
    }
    const verdict = await check(cid, bytes);
    if (verdict.kind === 'match') {
      return bytes;
    }
    // Unverified, so this read goes to the network, and the copy waits for a verifier that loads.
    if (verdict.kind === 'unknown') {
      return null;
    }
    // Corrupted on disk. Dropped so the network copy takes its place.
    void store.delete(cid).catch((error: unknown) => {
      reportRelayFailure({ step: 'cache_delete', error });
    });
    return null;
  }

  async function serve(cid: string, signal: AbortSignal): Promise<ServedBlock> {
    if (cache !== null) {
      const cached = await readCached(cache, cid);
      if (cached !== null) {
        return { bytes: cached, from: 'cache' };
      }
    }
    const bytes = await blocks(cid, signal);
    // The sandbox re-hashes only the root block, so this is the check for every other block a peer sends.
    const verdict = await check(cid, bytes);
    if (verdict.kind === 'mismatch') {
      const error = setErrorName(new Error(`Block ${cid} does not hash to its CID`), VERIFICATION_ERROR);
      reportRelayFailure({ step: 'verify', error, cid, reason: 'mismatch' });
      throw error;
    }
    // Fail closed. The verifier already reported why it could not run, so this refusal is not reported again.
    if (verdict.kind === 'unknown') {
      throw setErrorName(
        new Error(`Block ${cid} could not be checked against its CID`, { cause: verdict.cause }),
        VERIFICATION_ERROR,
      );
    }
    if (cache !== null) {
      // The reply detaches `bytes.buffer` before the IndexedDB write clones it.
      void cache.put(cid, bytes.slice()).catch((error: unknown) => {
        reportRelayFailure({ step: 'cache_write', error });
      });
    }
    return { bytes, from: 'network' };
  }

  const stopAborts = channel.on('dotli:bitswap-abort', (data, { origin, source }) => {
    const key = getFrameKey({ frame: data.frame, origin, source });
    if (key === null) {
      return;
    }
    // Only this frame's own fetches, so one product cannot cancel another's.
    const own = inFlight.get(key);
    if (own === undefined) {
      return;
    }
    for (const id of data.ids) {
      own.get(id)?.abort();
      own.delete(id);
    }
    if (own.size === 0) {
      inFlight.delete(key);
    }
  });

  const stopGets = channel.on('dotli:bitswap-get', (data, { origin, source }) => {
    if (source === null) {
      return;
    }
    const aborter = new AbortController();
    const key = getFrameKey({ frame: data.frame, origin, source });
    let own = inFlight.get(key);
    if (own === undefined) {
      own = new Map<string, AbortController>();
      inFlight.set(key, own);
    }
    own.set(data.id, aborter);
    void serve(data.cid, aborter.signal)
      .finally(() => {
        // A reused id must not have the earlier fetch's cleanup drop the newer entry.
        if (own.get(data.id) === aborter) {
          own.delete(data.id);
        }
        if (own.size === 0) {
          inFlight.delete(key);
        }
      })
      .then(served => {
        noteBlock(data.cid, served);
        const reply: BitswapResultMessage = {
          type: 'dotli:bitswap-result',
          id: data.id,
          ok: true,
          bytes: served.bytes,
        };
        // The cache and the client return a fresh copy, so its buffer is an `ArrayBuffer` holding this block alone.
        source.postMessage(reply, { targetOrigin: origin, transfer: [served.bytes.buffer as ArrayBuffer] });
      })
      .catch((err: unknown) => {
        const name = getErrorName(err);
        const code = errorCode(err);
        const reply: BitswapResultMessage = {
          type: 'dotli:bitswap-result',
          id: data.id,
          ok: false,
          error: serializeError(err),
          ...(name !== undefined ? { errorName: name } : {}),
          ...(code !== null ? { code } : {}),
        };
        source.postMessage(reply, { targetOrigin: origin });
      });
  });

  return {
    /** Hears the running total after each served block. Returns the unsubscribe. */
    onProgress: progressListeners.subscribe,
    /** Hears where each served block came from. Returns the unsubscribe. */
    onServed: servedListeners.subscribe,
    /** Stops answering new requests. Fetches already running still answer their frame. */
    stop(): void {
      stopAborts();
      stopGets();
    },
  };
}

/** A relay step that failed and was worked around, reported so the workaround does not hide it. */
function reportRelayFailure({ step, error, cid, reason = getErrorName(error) }: ReportRelayFailureParams): void {
  captureException(error, { flow: 'content', step: `relay_${step}`, ...(cid === undefined ? {} : { tags: { cid } }) });
  log.error(`[dot.li bitswap-relay] ${step} failed${cid === undefined ? '' : ` for ${cid}`}: ${serializeError(error)}`);
  m.count(S.CONTENT_BLOCK_RELAY, { outcome: 'error', reason: reason ?? 'unknown', step });
}
