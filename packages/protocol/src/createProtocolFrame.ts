// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The hidden protocol iframe: it boots on demand, publishes where it stands, rebuilds itself when it is lost, and hands
// the layers above the transport to the frame there is now. Each iframe gets its own provider and transport, so a
// message from a dropped iframe reaches only that iframe's disposed provider.

import { atom } from 'nanostores';
import { getResolutionId, m, reportListener, spans as S } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  createListenerSet,
  createDeferred,
  log,
  realTimers,
  toError,
  waitForStatus,
  withTimeout,
} from '@dotli/shared';
import { createTransport, createWindowProvider } from '@dotli/transport';
import { createWireReport } from './createWireReport.js';
import { PROTOCOL_ERRORS, ProtocolVersionMismatchError, fromTransportError } from './errors.js';
import type {
  FrameElement,
  ProtocolFrame,
  ProtocolFrameConfig,
  ProtocolFrameParams,
  ProtocolFrameTimeouts,
  ProtocolStatus,
} from './frameTypes.js';
import { FRAME_MODES } from './getBackendOfFrameMode.js';
import { reportBootFailure, type BootPhase } from './reportBootFailure.js';
import { reportFrameLost } from './reportFrameLost.js';
import { protocolSchema, type ProtocolTransport } from './schema.js';
import { subscribe } from './subscribe.js';

/**
 * One iframe and the transport to it, which is built once the iframe loaded. Its first call starts the handshake, and a
 * frame hears none before its document loads, so no call can go out before.
 */
type FrameSlot = ReturnType<typeof createFrameSlot>;

export const DEFAULT_FRAME_TIMEOUTS: ProtocolFrameTimeouts = {
  configureMs: 30_000,
  loadMs: 30_000,
  // Below the transport's 10 s, so a silent frame has failed when a wallet read gives up, and the retry boots anew.
  handshakeMs: 5_000,
  readyMs: 240_000,
  rebuildMs: 2_000,
  maxRebuildMs: 30_000,
  stableMs: 30_000,
};

/** Where the build serves the frame on its origin. */
const PROTOCOL_PATH = '/p/';

/** The hidden protocol frame on `document` at `origin`, hearing its messages on `window`. Boots nothing until asked. */
export function createProtocolFrame<E extends FrameElement>({
  origin,
  document: frameDocument,
  window: messages,
  timeouts: timeoutOverrides,
  timers = realTimers,
  count = m.count,
}: ProtocolFrameParams<E>): ProtocolFrame {
  const timeouts: ProtocolFrameTimeouts = { ...DEFAULT_FRAME_TIMEOUTS, ...timeoutOverrides };
  const wire = createWireReport({ side: 'host', count });

  const status = atom<ProtocolStatus>('idle');
  const lostListeners = createListenerSet<Error>({
    onListenerError: reportListener('protocol', 'protocol.frame_lost'),
  });
  // Why the frame is down, for a caller that asks before it is back.
  let downReason: Error = new Error(PROTOCOL_ERRORS.FRAME_RESET);
  // The frame being booted or kept, and nothing while the frame is down.
  let slot: FrameSlot | null = null;
  // Stops the keeper when the host drops the frame on purpose.
  let keeper: AbortController | null = null;
  let losses = 0;
  // Whether a ready frame's loss was captured since the last frame that stayed ready for `stableMs`. A frame that keeps
  // dying soon after ready is counted every time but captured once, so a rebuild loop does not flood the error tracker.
  let lossCapturedSinceStable = false;
  // A frame that refused the host's wire version. Rebuilding cannot fix it and a reload can, so it is final.
  let mismatch: ProtocolVersionMismatchError | null = null;

  let frameConfig: ProtocolFrameConfig | null = null;
  const configured = createDeferred<undefined>();

  // One task keeps the frame. It retries without end, each wait doubling, and settles only when a frame it kept
  // stable is lost.
  const frameKeeper = createAsyncTaskPool({
    poolSize: 1,
    retryCount: Number.POSITIVE_INFINITY,
    retryDelay: retry => Math.min(timeouts.rebuildMs * 2 ** retry, timeouts.maxRebuildMs),
    timers,
  });

  /**
   * Drops the frame. Its transport is disposed after the status changed, so a caller its calls fail finds it down. The
   * transport posts nothing as it closes, so the frame lets go of what it served once its iframe goes.
   */
  function loseFrame(error: Error, next: 'failed' | 'idle'): void {
    const lost = slot;
    slot = null;
    downReason = error;
    losses += 1;
    lost?.loss.abort(error);
    lost?.loaded.reject(error);
    // A status listener that throws fails the drop for its writer, and the frame is let go of all the same.
    try {
      status.set(next);
    } finally {
      lost?.transport?.dispose(error);
      lost?.iframe?.remove();
      lostListeners.emit(error);
    }
  }

  /** The transport to the slot's iframe, which has loaded. */
  function openTransport(kept: FrameSlot): ProtocolTransport {
    return createTransport({
      schema: protocolSchema,
      provider: createWindowProvider({
        listen: messages,
        peer: () => kept.iframe?.contentWindow ?? null,
        origin,
        // The provider drops what is not bytes before the transport sees it, so this is its only count.
        onNotBytes: wire.onNotBytes,
      }),
      handshake: 'offer',
      // The frame reads the resolution id from its URL, which it needs before any handshake.
      hello: { resolutionId: null },
      timers,
      timeoutMs: timeouts.handshakeMs,
      onIssue: wire.onIssue,
    });
  }

  /** Hears the frame's status. It is the first call on the transport, so it starts the handshake. */
  function watchStatus(kept: FrameSlot, transport: ProtocolTransport): void {
    subscribe({
      transport,
      method: protocolSchema.sections.frame.status,
      start: undefined,
      listeners: {
        receive: () => {
          if (slot === kept) {
            status.set('ready');
          }
        },
        // A dropped frame's own status ends with its loss, which was counted when it was dropped.
        end: error => {
          if (slot === kept) {
            kept.loss.abort(error ?? new Error(PROTOCOL_ERRORS.FRAME_STATUS_ENDED));
          }
        },
      },
    });
  }

  function createIframe(config: ProtocolFrameConfig): E {
    const iframe = frameDocument.createElement('iframe');
    const params = new URLSearchParams();
    params.set('mode', FRAME_MODES[config.backend]);
    params.set('network', config.network);
    if (config.skipWorkerCache) {
      params.set('skipWorkerCache', '1');
    }
    // On the URL, not posted after load, because the iframe's Sentry client emits before any handshake.
    const resolutionId = getResolutionId();
    if (resolutionId !== null) {
      params.set('resolutionId', resolutionId);
    }
    const query = params.toString();
    iframe.src = query.length > 0 ? `${origin}${PROTOCOL_PATH}?${query}` : `${origin}${PROTOCOL_PATH}`;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none;border:0;';
    return iframe;
  }

  /**
   * Mounts the frame and resolves on its `load` with the transport built there, since a post to a frame that has not
   * committed its document is dropped. `load` also fires when the frame's script failed, which the handshake's own
   * timeout then finds.
   */
  function waitUntilLoaded(kept: FrameSlot, iframe: E): Promise<ProtocolTransport> {
    const signal = kept.loss.signal;
    return new Promise<ProtocolTransport>((resolve, reject) => {
      function handleLoad(): void {
        release();
        const transport = openTransport(kept);
        kept.transport = transport;
        // First, so the status goes out ahead of the calls that waited for the load.
        watchStatus(kept, transport);
        kept.loaded.resolve(transport);
        resolve(transport);
      }
      function handleError(): void {
        release();
        reject(new Error(PROTOCOL_ERRORS.HOST_FRAME_LOAD_FAILED));
      }
      function handleAbort(): void {
        release();
        reject(toError(signal.reason));
      }
      function release(): void {
        iframe.removeEventListener('load', handleLoad);
        iframe.removeEventListener('error', handleError);
        signal.removeEventListener('abort', handleAbort);
      }
      iframe.addEventListener('load', handleLoad, { once: true });
      iframe.addEventListener('error', handleError, { once: true });
      signal.addEventListener('abort', handleAbort, { once: true });
      frameDocument.body.appendChild(iframe);
    });
  }

  /**
   * Boots a frame and holds it until it is lost. Settles only when the lost frame had been ready for `stableMs`, or
   * refused the host's wire version, so a frame that never comes up, or dies soon after, is retried by the pool with
   * ever longer waits.
   */
  async function keepFrame(run: AbortSignal, config: ProtocolFrameConfig): Promise<void> {
    const kept = createFrameSlot();
    slot = kept;
    // Before anything that can throw, so a failure is reported as this keeper's and is not retried by each caller.
    status.set('booting');
    // A listener heard `booting` and changed the config already when this set ran outside a listener round. Inside
    // one, a later change drops this boot through the slot.
    if (run.aborted) {
      return;
    }
    let phase: BootPhase = 'load';
    let readyAt: number | null = null;
    try {
      const iframe = createIframe(config);
      kept.iframe = iframe;
      const transport = await withTimeout({
        work: waitUntilLoaded(kept, iframe),
        ms: timeouts.loadMs,
        timeoutError: () => new Error(PROTOCOL_ERRORS.HOST_FRAME_LOAD_TIMEOUT),
        timers,
      });
      phase = 'listen';
      await transport.whenConnected();
      if (slot === kept && status.get() === 'booting') {
        status.set('listening');
      }
      phase = 'ready';
      const stopReady = m.timer(S.PROTOCOL_IFRAME_READY);
      try {
        await withTimeout({
          work: waitForStatus(status, next => next === 'ready', { signal: kept.loss.signal }),
          ms: timeouts.readyMs,
          timeoutError: () => new Error(PROTOCOL_ERRORS.FRAME_READY_TIMEOUT),
          timers,
        });
      } finally {
        stopReady();
      }
      readyAt = timers.now();
      await waitForStatus(status, () => false, { signal: kept.loss.signal });
    } catch (thrown: unknown) {
      // A failed handshake rejects with the transport's own error, which the host knows by the protocol's class.
      const reason = fromTransportError(toError(thrown));
      const stable = readyAt !== null && timers.now() - readyAt >= timeouts.stableMs;
      // Still the frame, so this keeper found the failure, not a config change.
      if (slot === kept) {
        if (readyAt === null) {
          reportBootFailure({ phase, error: reason, name: thrown instanceof Error ? reason.name : 'unknown', count });
        } else if (reportFrameLost({ error: reason, count, capture: stable || !lossCapturedSinceStable })) {
          lossCapturedSinceStable = true;
        }
        if (reason instanceof ProtocolVersionMismatchError) {
          mismatch = reason;
        }
        loseFrame(reason, 'failed');
      }
      if (mismatch !== null || stable) {
        return;
      }
      throw reason;
    }
  }

  /** Keeps a frame until a config change drops it, a new keeper after each stable frame is lost. */
  function keep(delay: number, config: ProtocolFrameConfig): void {
    const run = new AbortController();
    keeper = run;
    frameKeeper
      .call(() => keepFrame(run.signal, config), { delay, signal: run.signal })
      .then(
        () => {
          // Still `config`, since a change aborts the run. A mismatch keeps no frame.
          if (!run.signal.aborted && mismatch === null) {
            keep(timeouts.rebuildMs, config);
          }
        },
        () => {
          // Only an abort rejects the endless retries. A config change has already dropped the frame, and a caller that
          // cut the backoff short has already started the keeper that replaces this one.
        },
      );
  }

  /** Boots a frame unless one is already asked for. A caller waiting on a frame that is down cuts its backoff short. */
  function askForFrame(config: ProtocolFrameConfig): void {
    if (mismatch !== null) {
      return;
    }
    const now = status.get();
    switch (now) {
      case 'idle':
        keep(0, config);
        return;
      case 'failed':
        // The pool frees an aborted run's slot at once, so the boot below is the only keeper.
        keeper?.abort(new Error(PROTOCOL_ERRORS.FRAME_RESET));
        keep(0, config);
        return;
      case 'booting':
      case 'listening':
      case 'ready':
        return;
    }
  }

  function waitUntilConfigured(): Promise<void> {
    return withTimeout({
      work: configured.promise,
      ms: timeouts.configureMs,
      timeoutError: () => new Error(PROTOCOL_ERRORS.FRAME_UNCONFIGURED),
      timers,
    });
  }

  /** Runs `run` with the config, in the turn it is called once there is one, and never after a version mismatch. */
  function withConfig<T>(run: (config: ProtocolFrameConfig) => Promise<T>): Promise<T> {
    if (mismatch !== null) {
      return Promise.reject(mismatch);
    }
    if (frameConfig === null) {
      return waitUntilConfigured().then(() => withConfig(run));
    }
    return run(frameConfig);
  }

  function waitUntilReady(): Promise<ProtocolTransport> {
    return withConfig(config => {
      // Taken before the boot, since a frame that cannot be built fails in the same turn it is asked for. A loss from
      // before this call is what the boot answers, so it does not fail the wait.
      const since = losses;
      askForFrame(config);
      // Read when the status is reached, since the frame can be dropped before the wait's continuation runs.
      let reached: ProtocolTransport | null = null;
      return waitForStatus(status, next => {
        switch (next) {
          case 'ready':
            reached = slot?.transport ?? null;
            return reached !== null || downReason;
          case 'idle':
            return downReason;
          case 'failed':
            return losses > since ? downReason : false;
          case 'booting':
          case 'listening':
            return false;
        }
      }).then(() => {
        if (reached === null) {
          throw downReason;
        }
        return reached;
      });
    });
  }

  function getTransport(): Promise<ProtocolTransport> {
    return withConfig(config => {
      askForFrame(config);
      // A keeper opens its slot in the turn it is asked for, so none here means its boot failed at once.
      return slot === null ? Promise.reject(downReason) : slot.loaded.promise;
    });
  }

  function configure(config: ProtocolFrameConfig): void {
    const previous = frameConfig;
    frameConfig = { ...config };
    if (previous === null) {
      configured.resolve(undefined);
      return;
    }
    if (mismatch !== null || isSameFrameConfig(previous, config) || status.get() === 'idle') {
      return;
    }
    // Told apart from a fatal in the trail, since both drop the frame.
    log.event('protocol frame reconfigured', {
      flow: 'protocol',
      backend: config.backend,
      network: config.network,
      skipWorkerCache: config.skipWorkerCache,
    });
    const reason = new Error(PROTOCOL_ERRORS.FRAME_RESET);
    keeper?.abort(reason);
    keeper = null;
    // A listener that heard `idle` may have asked for the frame already, and a second keeper would orphan one. It
    // may also have configured again, so the frame is built with the latest config, even when a listener threw.
    try {
      loseFrame(reason, 'idle');
    } finally {
      askForFrame(frameConfig);
    }
  }

  function onVersionMismatch(listener: (error: ProtocolVersionMismatchError) => void): () => void {
    if (mismatch !== null) {
      listener(mismatch);
      return () => undefined;
    }
    // A mismatch is final, so the loss that latches it is the last one.
    return lostListeners.subscribe(error => {
      if (error instanceof ProtocolVersionMismatchError) {
        listener(error);
      }
    });
  }

  return {
    getStatus: () => status.get(),
    // Each subscription its own listener, so one given twice is two subscriptions, and it hears the status alone.
    subscribeStatus: (listener: (next: ProtocolStatus) => void) =>
      status.listen(next => {
        listener(next);
      }),
    configure,
    getTransport,
    waitUntilReady,
    onVersionMismatch,
  };
}

function createFrameSlot() {
  const loaded = createDeferred<ProtocolTransport>();
  // No caller may be waiting for the load, and the loss is reported where the frame is dropped.
  loaded.promise.catch(() => undefined);
  // The two widenings let the frame set each field later. A bare `null` would type it as `null` alone.
  return {
    /** Null until it is built. */
    iframe: null as FrameElement | null,
    /** Aborted with why the frame is gone, which ends whatever its keeper waits on. */
    loss: new AbortController(),
    /** Null until the iframe loaded, for what must reach it in the turn the frame is dropped or ready. */
    transport: null as ProtocolTransport | null,
    /** Resolves with the transport once the iframe loaded, and rejects with the loss of a frame dropped before. */
    loaded,
  };
}

function isSameFrameConfig(left: ProtocolFrameConfig, right: ProtocolFrameConfig): boolean {
  return (
    left.backend === right.backend && left.network === right.network && left.skipWorkerCache === right.skipWorkerCache
  );
}
