// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves a sandbox frame's block requests from the host. The sandbox runs no light client, and its credentialless
// origin loses its storage on every reload, so the host fetches and keeps the blocks.

import type { BitswapResultMessage, SandboxChannel } from '@dotli/sandbox-wire';
import { createReporter, defineCount } from '@dotli/metrics';
import { createListenerSet, createStateMachine, getErrorName, serializeError, type MachineTypes } from '@dotli/shared';

import { readDagTotal } from './readDagTotal.js';
import { errorCode } from './errors.js';
import { serveBlock, type BlockOrigin, type BlockSources, type ServedBlock } from './serveBlock.js';

const report = createReporter({ flow: 'content' });

const blockRelayTransitionMetric = defineCount<'error'>('block_relay.transition');

/** Every served block passes here. The root's link `Tsize` sum gives the total up front, so progress is real. */
export type ContentProgress = {
  bytesFetched: number;
  totalBytes: number | null;
  bytesPerSecond: number;
};

type Params = BlockSources & {
  /** Hands over only messages from a trusted sandbox origin. */
  channel: SandboxChannel;
  /** The clock the transfer speed is measured on. */
  now?: () => number;
};

export type SandboxBlockRelay = ReturnType<typeof createSandboxBlockRelay>;

/** A frame's id with its origin, or the window of a sandbox that sends no id. */
type FrameKey = MessageEventSource | string;

/** A block a frame asked for, with the controller its frame's abort stops. */
type BlockRequest = {
  key: FrameKey;
  id: string;
  cid: string;
  origin: string;
  source: MessageEventSource;
  aborter: AbortController;
};

/** The running load's count. A walk asks for its root first and only once, so the root asked again is a new load. */
type Load = { root: string; totalBytes: number | null; bytesFetched: number; startedAt: number };

/**
 * The live requests, so a sandbox can abort its own on `pagehide`. One request per frame and id, since ids restart at 1
 * in each frame. A frame is the id it sends together with its origin, since its abort arrives after it is gone and
 * without a source, and another product's sandbox may send the same id. A sandbox that sends no id is known by its
 * window. `load` is `null` until the first block is served.
 */
type RelayState = { kind: 'serving'; requests: readonly BlockRequest[]; load: Load | null };

type RelayEvent =
  | { kind: 'blockAsked'; request: BlockRequest }
  | { kind: 'abortAsked'; key: FrameKey; ids: readonly string[] }
  | { kind: 'blockServed'; request: BlockRequest; served: ServedBlock }
  | { kind: 'blockFailed'; request: BlockRequest; error: unknown };

type RelayEffect =
  | { kind: 'abort'; requests: readonly BlockRequest[] }
  | { kind: 'progress'; load: Load; from: BlockOrigin }
  | { kind: 'reply'; request: BlockRequest; bytes: Uint8Array }
  | { kind: 'replyFailure'; request: BlockRequest; error: unknown };

/**
 * Creates the host side of the sandbox's block channel, which serves, verifies and caches the blocks the sandbox asks
 * for.
 *
 * @example
 * const relay = createSandboxBlockRelay({ channel, blocks: fetchBlock, cache: null, verify: verifyBlock });
 * const stop = relay.onProgress(showProgress);
 */
export function createSandboxBlockRelay({ channel, now = () => performance.now(), ...sources }: Params) {
  // A listener's throw must not fail a block the sandbox already got, nor keep the next listener from hearing it.
  const progressListeners = createListenerSet<ContentProgress>({
    onListenerError: report.listener('bitswap_relay.progress'),
  });
  const servedListeners = createListenerSet<BlockOrigin>({
    onListenerError: report.listener('bitswap_relay.served'),
  });

  const relay = createStateMachine<MachineTypes<RelayState, RelayEvent, RelayEffect>>({
    initial: { kind: 'serving', requests: [], load: null },
    handlers: {
      serving: {
        blockAsked(state, { request }, { emitState, update }) {
          // A reused id replaces the request under it, so the frame's abort stops the newer one.
          const others = state.requests.filter(r => r.key !== request.key || r.id !== request.id);
          emitState({ ...state, requests: [...others, request] });
          update(
            serveBlock(request.cid, request.aborter.signal, sources).then(
              served => ({ kind: 'blockServed', request, served }),
              (error: unknown) => ({ kind: 'blockFailed', request, error }),
            ),
          );
        },
        abortAsked(state, { key, ids }, { emitState, emitSideEffect }) {
          // Only this frame's own fetches, so one product cannot cancel another's.
          const aborted = state.requests.filter(r => r.key === key && ids.includes(r.id));
          if (aborted.length === 0) {
            return;
          }
          emitState({ ...state, requests: state.requests.filter(r => !aborted.includes(r)) });
          emitSideEffect({ kind: 'abort', requests: aborted });
        },
        blockServed(state, { request, served }, { emitState, emitSideEffect }) {
          // A request its frame aborted, or a newer one under its id replaced, is not part of the frame's load.
          if (state.requests.includes(request)) {
            const load = countBlock(state.load, request.cid, served.bytes);
            emitState({ ...state, requests: state.requests.filter(r => r !== request), load });
            emitSideEffect({ kind: 'progress', load, from: served.from });
          }
          emitSideEffect({ kind: 'reply', request, bytes: served.bytes });
        },
        blockFailed(state, { request, error }, { emitState, emitSideEffect }) {
          emitState({ ...state, requests: state.requests.filter(r => r !== request) });
          emitSideEffect({ kind: 'replyFailure', request, error });
        },
      },
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'abort':
          for (const request of effect.requests) {
            request.aborter.abort();
          }
          return;
        case 'progress': {
          const { bytesFetched, totalBytes, startedAt } = effect.load;
          const elapsed = now() - startedAt;
          progressListeners.emit({
            bytesFetched,
            totalBytes,
            bytesPerSecond: elapsed > 0 ? (bytesFetched / elapsed) * 1000 : 0,
          });
          servedListeners.emit(effect.from);
          return;
        }
        case 'reply': {
          const { request, bytes } = effect;
          const reply: BitswapResultMessage = { type: 'dotli:bitswap-result', id: request.id, ok: true, bytes };
          // The cache and the client return a fresh copy, so its buffer is an `ArrayBuffer` holding this block alone.
          request.source.postMessage(reply, { targetOrigin: request.origin, transfer: [bytes.buffer as ArrayBuffer] });
          return;
        }
        case 'replyFailure': {
          const { request, error } = effect;
          const name = getErrorName(error);
          const code = errorCode(error);
          const reply: BitswapResultMessage = {
            type: 'dotli:bitswap-result',
            id: request.id,
            ok: false,
            error: serializeError(error),
            ...(name !== undefined ? { errorName: name } : {}),
            ...(code !== null ? { code } : {}),
          };
          request.source.postMessage(reply, { targetOrigin: request.origin });
          return;
        }
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: blockRelayTransitionMetric,
        message: '[dot.li bitswap-relay] A block relay transition threw',
      });
    },
  });

  const stopAborts = channel.on('dotli:bitswap-abort', ({ frame, ids }, { origin, source }) => {
    // A sandbox that sends no frame id is known by its window, so an abort from no window names no frame.
    const key = getFrameKey(frame, origin, source);
    if (key === null) {
      return;
    }
    relay.update({ kind: 'abortAsked', key, ids });
  });

  const stopGets = channel.on('dotli:bitswap-get', ({ frame, id, cid }, { origin, source }) => {
    if (source === null) {
      return;
    }
    const key = getFrameKey(frame, origin, source);
    relay.update({ kind: 'blockAsked', request: { key, id, cid, origin, source, aborter: new AbortController() } });
  });

  return {
    /** Hears the running total after each served block. Returns the unsubscribe. */
    onProgress: progressListeners.subscribe,
    /** Hears where each block came from, for a request its frame has not aborted. Returns the unsubscribe. */
    onServed: servedListeners.subscribe,
    /** Stops answering new requests. Fetches already running still answer their frame. */
    stop(): void {
      stopAborts();
      stopGets();
    },
  };

  /** `load` with the block `cid` added. */
  function countBlock(load: Load | null, cid: string, bytes: Uint8Array): Load {
    // A retry in the sandbox, or a frame the host rendered again, walks from the root again and counts from zero.
    const counted =
      load === null || cid === load.root
        ? { root: cid, totalBytes: readDagTotal(bytes), bytesFetched: 0, startedAt: now() }
        : load;
    return { ...counted, bytesFetched: counted.bytesFetched + bytes.length };
  }
}

/** The frame a message came from: the id the sandbox sent with its origin, or its window when it sent none. */
function getFrameKey<Source extends MessageEventSource | null>(
  frame: string | undefined,
  origin: string,
  source: Source,
): Source | string {
  return frame === undefined ? source : `${origin} ${frame}`;
}
