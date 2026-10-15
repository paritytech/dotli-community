// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves a sandbox frame's block requests from the host. The sandbox runs no light client, and its credentialless
// origin loses its storage on every reload, so the host fetches and keeps the blocks.

import type { BitswapResultMessage, SandboxChannel } from '@dotli/sandbox-wire';
import { captureException, m, recordExpected, reportListener, spans as S } from '@dotli/metrics';
import { createListenerSet, errorName, log, named, serializeError } from '@dotli/shared';

import { readDagTotal } from './dag-total.js';
import { errorCode } from './errors.js';

/** Every served block passes here. The root's link `Tsize` sum gives the total up front, so progress is real. */
export interface ContentProgress {
  bytesFetched: number;
  totalBytes: number | null;
  bytesPerSecond: number;
}

export type BlockOrigin = 'cache' | 'network';

export interface BlockCache {
  /** Must return a fresh copy, since the relay transfers the buffer to the sandbox and detaches it. */
  get: (cid: string) => Promise<Uint8Array | null>;
  put: (cid: string, bytes: Uint8Array) => Promise<void>;
  delete: (cid: string) => Promise<void>;
}

export interface SandboxBlockRelayDeps {
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
}

export interface SandboxBlockRelay {
  /** Hears the running total after each served block. Returns the unsubscribe. */
  onProgress(listener: (progress: ContentProgress) => void): () => void;
  /** Hears where each served block came from. Returns the unsubscribe. */
  onServed(listener: (from: BlockOrigin) => void): () => void;
  /** Stops answering new requests. Fetches already running still answer their frame. */
  stop(): void;
}

/** `unknown` when the verifier could not run, which says nothing about the bytes. */
type Verdict = { kind: 'match' } | { kind: 'mismatch' } | { kind: 'unknown'; cause: unknown };

interface ServedBlock {
  bytes: Uint8Array;
  from: BlockOrigin;
}

/**
 * Spelled as `CONTENT_ERRORS.VERIFICATION`, which bitswap may not import. The sandbox branches on this name.
 */
const VERIFICATION_ERROR = 'ContentVerificationError';

type RelayStep = 'verify' | 'cache_read' | 'cache_delete' | 'cache_write';

/** A relay step that failed and was worked around, reported so the workaround does not hide it. */
function reportRelayFailure(step: RelayStep, err: unknown, cid?: string, reason = errorName(err)): void {
  captureException(err, { flow: 'content', step: `relay_${step}`, ...(cid === undefined ? {} : { tags: { cid } }) });
  log.error(`[dot.li bitswap-relay] ${step} failed${cid === undefined ? '' : ` for ${cid}`}: ${serializeError(err)}`);
  m.count(S.CONTENT_BLOCK_RELAY, { outcome: 'error', reason: reason ?? 'unknown', step });
}

/** A frame's id with its origin, or the window of a sandbox that sends no id. */
type FrameKey = MessageEventSource | string;

export function createSandboxBlockRelay(deps: SandboxBlockRelayDeps): SandboxBlockRelay {
  const { channel, blocks, cache, now = () => performance.now() } = deps;
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
  function frameKey(frame: string | undefined, origin: string, source: MessageEventSource): FrameKey;
  function frameKey(frame: string | undefined, origin: string, source: MessageEventSource | null): FrameKey | null;
  function frameKey(frame: string | undefined, origin: string, source: MessageEventSource | null): FrameKey | null {
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
      return (await deps.verify(cid, bytes)) ? { kind: 'match' } : { kind: 'mismatch' };
    } catch (err) {
      // The verifier reported why it could not run, so each block it leaves unchecked is a breadcrumb and a count.
      recordExpected(err, { flow: 'content', step: 'relay_verify' });
      m.count(S.CONTENT_BLOCK_RELAY, { outcome: 'error', reason: errorName(err) ?? 'unknown', step: 'verify' });
      return { kind: 'unknown', cause: err };
    }
  }

  async function readCached(store: BlockCache, cid: string): Promise<Uint8Array | null> {
    let bytes: Uint8Array | null;
    try {
      bytes = await store.get(cid);
    } catch (err) {
      reportRelayFailure('cache_read', err);
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
    void store.delete(cid).catch((err: unknown) => {
      reportRelayFailure('cache_delete', err);
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
      const err = named(new Error(`Block ${cid} does not hash to its CID`), VERIFICATION_ERROR);
      reportRelayFailure('verify', err, cid, 'mismatch');
      throw err;
    }
    // Fail closed. The verifier already reported why it could not run, so this refusal is not reported again.
    if (verdict.kind === 'unknown') {
      throw named(
        new Error(`Block ${cid} could not be checked against its CID`, { cause: verdict.cause }),
        VERIFICATION_ERROR,
      );
    }
    if (cache !== null) {
      // The reply detaches `bytes.buffer` before the IndexedDB write clones it.
      void cache.put(cid, bytes.slice()).catch((err: unknown) => {
        reportRelayFailure('cache_write', err);
      });
    }
    return { bytes, from: 'network' };
  }

  const stopAborts = channel.on('dotli:bitswap-abort', (data, { origin, source }) => {
    const key = frameKey(data.frame, origin, source);
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
    const key = frameKey(data.frame, origin, source);
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
        source.postMessage(reply, { targetOrigin: origin, transfer: [served.bytes.buffer as ArrayBuffer] });
      })
      .catch((err: unknown) => {
        const name = errorName(err);
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
    onProgress: progressListeners.subscribe,
    onServed: servedListeners.subscribe,
    stop() {
      stopAborts();
      stopGets();
    },
  };
}
