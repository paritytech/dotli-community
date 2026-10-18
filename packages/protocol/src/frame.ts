// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The hidden protocol iframe: it boots on demand, publishes where it stands, rebuilds itself when it is lost, and hands
// the layers above the transport to the frame there is now. Each iframe gets its own provider and transport, so a
// message from a dropped iframe reaches only that iframe's disposed provider.

import { parseBackend, type Backend, type Network } from '@dotli/config';
import { captureException, getResolutionId, m, reportListener, spans as S } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  createStatusCell,
  deferred,
  log,
  realTimers,
  serializeError,
  toError,
  withTimeout,
  type Timers,
} from '@dotli/shared';
import { createTransport, createWindowProvider, type MessageTarget, type WindowLike } from '@dotli/transport';
import { PROTOCOL_ERRORS, ProtocolVersionMismatchError } from './errors.js';
import { protocolListeners } from './listeners.js';
import { fromTransportError } from './outcomes.js';
import { protocolSchema, type ProtocolTransport } from './schema.js';
import { subscribe } from './subscription.js';
import { createIssueReporter } from './wire-issues.js';

/**
 * Where the protocol frame stands. `idle` before anything asked for it. `booting` while it loads. `listening` once it
 * answered the handshake, so it answers shared store requests, which in SharedWorker mode is long before its light
 * client is `ready`. `failed` while it is down, until a rebuild boots, either the frame's own after a backoff or one a
 * caller asked for, and for good after a version mismatch.
 */
export type ProtocolStatus = 'idle' | 'booting' | 'listening' | 'ready' | 'failed';

/**
 * The frame's URL names the backend in its own words. A host page the service worker cached from an earlier release
 * still sends them, so they stay. `rpc` bridges chain calls over trusted WSS JSON-RPC instead of smoldot.
 */
const FRAME_MODES = {
  'smoldot-shared-worker': 'shared-worker',
  'smoldot-direct': 'direct',
  'rpc-gateway': 'rpc',
} as const satisfies Record<Backend, string>;

/** The backend a frame URL's `mode` names, or null for a word this build does not know. */
export function backendOfFrameMode(mode: string): Backend | null {
  return parseBackend(Object.entries(FRAME_MODES).find(([, word]) => word === mode)?.[0] ?? null);
}

/** What the frame is built with. A change rebuilds it. */
export interface ProtocolFrameConfig {
  backend: Backend;
  network: Network;
  /** Asks the frame to purge its IndexedDB caches first, forcing a cold start. */
  skipWorkerCache: boolean;
}

/** How long each step of the frame's lifecycle may take. */
export interface ProtocolFrameTimeouts {
  /** A wait begun before the first config, so a page that never configures the frame fails its requests. */
  configureMs: number;
  /** The frame document loads. The handshake that follows has its own timeout. */
  loadMs: number;
  /** Ready follows the SharedWorker presync, so this must exceed `TIMEOUTS.SHARED_WORKER_READY`. */
  readyMs: number;
  /** The first wait before a lost frame is rebuilt. It doubles after each rebuild that does not stay up. */
  rebuildMs: number;
  /** The longest wait between rebuilds. */
  maxRebuildMs: number;
  /** A frame ready this long has recovered, so losing it starts the waits over. */
  stableMs: number;
}

const DEFAULT_FRAME_TIMEOUTS: ProtocolFrameTimeouts = {
  configureMs: 30_000,
  loadMs: 30_000,
  readyMs: 240_000,
  rebuildMs: 2_000,
  maxRebuildMs: 30_000,
  stableMs: 30_000,
};

/** The hidden iframe, as much of it as the frame uses. An `HTMLIFrameElement` is one. */
export interface FrameElement {
  src: string;
  tabIndex: number;
  readonly style: { cssText: string };
  readonly contentWindow: WindowLike | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: 'load' | 'error', listener: () => void, options: { once: true }): void;
  removeEventListener(type: 'load' | 'error', listener: () => void): void;
  remove(): void;
}

/** Builds and mounts the hidden frame's iframe, an `E`. The page's `document` in the browser. */
export interface FrameDocument<E extends FrameElement> {
  createElement(tagName: 'iframe'): E;
  readonly body: { appendChild(node: E): E };
}

export interface ProtocolFrameDeps<E extends FrameElement> {
  /** The protocol frame's origin. Messages from any other origin are ignored. */
  origin: string;
  document: FrameDocument<E>;
  /** Where the frame's messages arrive. The page's `window` in the browser. */
  window: MessageTarget;
  timeouts?: Partial<ProtocolFrameTimeouts> | undefined;
  timers?: Timers | undefined;
  count?: typeof m.count | undefined;
}

export interface ProtocolFrame {
  getStatus(): ProtocolStatus;
  /** Called on each change only. Does not start a frame. */
  subscribeStatus(listener: (status: ProtocolStatus) => void): () => void;
  /**
   * Says what the frame is built with. Nothing boots before it, and waits begun before the first config wait for it,
   * up to `configureMs`.
   * The same config again does nothing. A different one rebuilds a frame already asked for at once, unless a frame
   * refused the host's wire version, which no rebuild fixes.
   */
  configure(config: ProtocolFrameConfig): void;
  /**
   * The transport of the frame there is now, booting one if there is none, once the frame is configured. Calls on it
   * wait in its queue until its handshake succeeds, and fail with the loss when the frame is dropped first. Rejects
   * with the version mismatch for good once a frame refused the host's wire. The transport itself speaks the transport
   * library's outcomes and errors, so a failed handshake rejects its calls with the library's timeout or mismatch
   * error. The frame rpc and `subscribe` turn those into the protocol's errors.
   */
  transport(): Promise<ProtocolTransport>;
  /**
   * The transport of the ready frame, booting one if none was asked for yet, once it is configured. A call while the
   * frame is down boots one at once instead of waiting out the rebuild backoff, and calls that find a boot under way
   * join it. Rejects with why when the boot it waits on fails, or when a config change drops the frame, so no caller is
   * left to its own timeout.
   */
  whenReady(): Promise<ProtocolTransport>;
  /**
   * Hears the version mismatch that left the frame down for good, once, and at once if it already did. A frame rebuilt
   * while an app is open can come from a newer release, and only a reload fixes that.
   */
  onVersionMismatch(listener: (error: ProtocolVersionMismatchError) => void): () => void;
}

/** One iframe and the transport to it. The transport exists before the iframe, so a `booting` listener can reach it. */
class FrameSlot<E extends FrameElement> {
  /** Null until it is built. */
  iframe: E | null = null;
  /** Aborted with why the frame is gone, which ends whatever its keeper waits on. */
  readonly loss = new AbortController();
  readonly transport: ProtocolTransport;

  constructor(open: (peer: () => WindowLike | null) => ProtocolTransport) {
    this.transport = open(() => this.iframe?.contentWindow ?? null);
  }
}

function sameFrameConfig(a: ProtocolFrameConfig, b: ProtocolFrameConfig): boolean {
  return a.backend === b.backend && a.network === b.network && a.skipWorkerCache === b.skipWorkerCache;
}

/** The frame's step that failed, so a failure is counted where it happened. */
type BootPhase = 'load' | 'listen' | 'ready';

/**
 * `name` labels the count: the error's name under the protocol's class, or `unknown` for a thrown value that is no
 * `Error`.
 */
function reportBootFailure(phase: BootPhase, error: Error, name: string, count: typeof m.count): void {
  count(S.PROTOCOL_IFRAME_READY, { outcome: 'error', phase, reason: name });
  m.breadcrumb(phase === 'ready' ? 'protocol iframe ready wait failed' : 'protocol iframe load failed', {
    reason: serializeError(error),
  });
  log.error(
    phase === 'ready' ? '[dot.li protocol] Ready wait failed:' : '[dot.li protocol] Host iframe load failed:',
    error,
  );
}

/**
 * Reports a frame lost after it was ready, once, and captures it when `capture` says so. Returns whether it captured. A
 * tab the SharedWorker let go of while it was frozen finds its port released when it thaws, which is expected, so that
 * loss is counted and left in the trail but never captured.
 */
function reportFrameLost(error: Error, count: typeof m.count, capture: boolean): boolean {
  const reason = error.name;
  count(S.PROTOCOL_FRAME_LOST, { outcome: 'error', reason });
  if (reason === 'ProtocolPortReleasedError') {
    log.event('protocol frame released', { flow: 'protocol', reason });
    return false;
  }
  m.breadcrumb('protocol frame lost', { reason: serializeError(error) });
  if (capture) {
    captureException(error, { flow: 'protocol', step: 'frame_lost' });
  }
  log.error(`[dot.li protocol] Frame lost: ${serializeError(error)}`);
  return capture;
}

export function createProtocolFrame<E extends FrameElement>(deps: ProtocolFrameDeps<E>): ProtocolFrame {
  const { origin, document: frameDocument, window: messages } = deps;
  const timeouts: ProtocolFrameTimeouts = { ...DEFAULT_FRAME_TIMEOUTS, ...deps.timeouts };
  const timers = deps.timers ?? realTimers;
  const count = deps.count ?? m.count;
  const reportIssue = createIssueReporter('host', count);

  const status = createStatusCell<ProtocolStatus>('idle', {
    onListenerError: reportListener('protocol', 'protocol.status'),
  });
  const lostListeners = protocolListeners<Error>('frame_lost');
  // Why the frame is down, for a caller that asks before it is back.
  let downReason: Error = new Error(PROTOCOL_ERRORS.FRAME_RESET);
  // The frame being booted or kept, and nothing while the frame is down.
  let slot: FrameSlot<E> | null = null;
  // Stops the keeper when the host drops the frame on purpose.
  let keeper: AbortController | null = null;
  let losses = 0;
  // Whether a ready frame's loss was captured since the last frame that stayed ready for `stableMs`. A frame that keeps
  // dying soon after ready is counted every time but captured once, so a rebuild loop does not flood the error tracker.
  let lossCapturedSinceStable = false;
  // A frame that refused the host's wire version. Rebuilding cannot fix it and a reload can, so it is final.
  let mismatch: ProtocolVersionMismatchError | null = null;

  let frameConfig: ProtocolFrameConfig | null = null;
  const configured = deferred<undefined>();

  // One task keeps the frame. It retries without end, each wait doubling, and settles only when a frame it kept
  // stable is lost.
  const frameKeeper = createAsyncTaskPool({
    poolSize: 1,
    retryCount: Number.POSITIVE_INFINITY,
    retryDelay: retry => Math.min(timeouts.rebuildMs * 2 ** retry, timeouts.maxRebuildMs),
    timers,
  });

  const setStatus = status.set;

  /**
   * Drops the frame. Its transport is disposed after the status changed, so a caller its calls fail finds it down, and
   * before its iframe goes, so the frame still hears the subscriptions it served stop.
   */
  function loseFrame(error: Error, next: 'failed' | 'idle'): void {
    const lost = slot;
    slot = null;
    downReason = error;
    losses += 1;
    lost?.loss.abort(error);
    setStatus(next);
    lost?.transport.dispose(error);
    lost?.iframe?.remove();
    lostListeners.emit(error);
  }

  /** A slot with its transport, which hears the frame's status from the start. */
  function openSlot(): FrameSlot<E> {
    const kept = new FrameSlot<E>(peer =>
      createTransport(
        protocolSchema,
        createWindowProvider({
          listen: messages,
          peer,
          origin,
          // The provider drops what is not bytes before the transport sees it, so this is its only count.
          onNotBytes: () => {
            reportIssue({ kind: 'refused', reason: 'not_bytes' });
          },
        }),
        // The frame reads the resolution id from its URL, which it needs before any handshake.
        { handshake: 'open', hello: { resolutionId: null }, timers, onIssue: reportIssue },
      ),
    );
    subscribe(kept.transport, protocolSchema.traits.frame.status, undefined, {
      receive: () => {
        if (slot === kept) {
          setStatus('ready');
        }
      },
      // A dropped frame's own status ends with its loss, which was counted when it was dropped.
      end: error => {
        if (slot === kept) {
          kept.loss.abort(error ?? new Error(PROTOCOL_ERRORS.FRAME_STATUS_ENDED));
        }
      },
    });
    return kept;
  }

  /**
   * Waits on the status until `verdict` settles the wait with `true` or fails it with an error, and fails with the
   * signal's reason when the frame is lost first.
   */
  function untilStatus(verdict: (status: ProtocolStatus) => boolean | Error, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // A frame lost before the wait began leaves nothing to start.
      if (signal?.aborted === true) {
        reject(toError(signal.reason));
        return;
      }
      let unsubscribe = (): void => undefined;
      let settled = false;
      const onStatus = (next: ProtocolStatus): void => {
        const outcome = verdict(next);
        if (outcome === true) {
          settle(null);
        } else if (outcome instanceof Error) {
          settle(outcome);
        }
      };
      const onAbort = (): void => {
        settle(toError(signal?.reason));
      };
      function settle(error: Error | null): void {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
        if (error === null) {
          resolve();
        } else {
          reject(error);
        }
      }
      // The status there is now settles the wait at once, so a frame already there costs no subscription.
      const now = verdict(status.get());
      if (now !== false) {
        if (now === true) {
          resolve();
        } else {
          reject(now);
        }
        return;
      }
      unsubscribe = status.subscribe(onStatus);
      signal?.addEventListener('abort', onAbort, { once: true });
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
    iframe.src = query.length > 0 ? `${origin}?${query}` : origin;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none;border:0;';
    return iframe;
  }

  /**
   * Mounts the frame and resolves on its `load`, where the handshake starts, since a post to a frame that has not
   * committed its document is dropped. `load` also fires when the frame's script failed, which the handshake's own
   * timeout then finds.
   */
  function untilLoaded(kept: FrameSlot<E>, iframe: E): Promise<void> {
    const signal = kept.loss.signal;
    return new Promise<void>((resolve, reject) => {
      const onLoad = (): void => {
        release();
        kept.transport.connect();
        resolve();
      };
      const onError = (): void => {
        release();
        reject(new Error(PROTOCOL_ERRORS.HOST_FRAME_LOAD_FAILED));
      };
      const onAbort = (): void => {
        release();
        reject(toError(signal.reason));
      };
      function release(): void {
        iframe.removeEventListener('load', onLoad);
        iframe.removeEventListener('error', onError);
        signal.removeEventListener('abort', onAbort);
      }
      iframe.addEventListener('load', onLoad, { once: true });
      iframe.addEventListener('error', onError, { once: true });
      signal.addEventListener('abort', onAbort, { once: true });
      frameDocument.body.appendChild(iframe);
    });
  }

  /**
   * Boots a frame and holds it until it is lost. Settles only when the lost frame had been ready for `stableMs`, or
   * refused the host's wire version, so a frame that never comes up, or dies soon after, is retried by the pool with
   * ever longer waits.
   */
  async function keepFrame(run: AbortSignal, config: ProtocolFrameConfig): Promise<void> {
    const kept = openSlot();
    slot = kept;
    // Before anything that can throw, so a failure is reported as this keeper's and is not retried by each caller.
    setStatus('booting');
    // A listener may have changed the config on `booting`, which dropped this boot and leaves nothing to mount for.
    if (run.aborted) {
      return;
    }
    let phase: BootPhase = 'load';
    let readyAt: number | null = null;
    try {
      const iframe = createIframe(config);
      kept.iframe = iframe;
      await withTimeout(
        untilLoaded(kept, iframe),
        timeouts.loadMs,
        () => new Error(PROTOCOL_ERRORS.HOST_FRAME_LOAD_TIMEOUT),
        timers,
      );
      phase = 'listen';
      await kept.transport.whenConnected();
      if (slot === kept && status.get() === 'booting') {
        setStatus('listening');
      }
      phase = 'ready';
      const stopReady = m.timer(S.PROTOCOL_IFRAME_READY);
      try {
        await withTimeout(
          untilStatus(next => next === 'ready', kept.loss.signal),
          timeouts.readyMs,
          () => new Error(PROTOCOL_ERRORS.FRAME_READY_TIMEOUT),
          timers,
        );
      } finally {
        stopReady();
      }
      readyAt = timers.now();
      await untilStatus(() => false, kept.loss.signal);
    } catch (thrown: unknown) {
      // A failed handshake rejects with the transport's own error, which the host knows by the protocol's class.
      const reason = fromTransportError(toError(thrown));
      const stable = readyAt !== null && timers.now() - readyAt >= timeouts.stableMs;
      // Still the frame, so this keeper found the failure, not a config change.
      if (slot === kept) {
        if (readyAt === null) {
          reportBootFailure(phase, reason, thrown instanceof Error ? reason.name : 'unknown', count);
        } else if (reportFrameLost(reason, count, stable || !lossCapturedSinceStable)) {
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
    if (now === 'idle') {
      keep(0, config);
    } else if (now === 'failed') {
      // The pool frees an aborted run's slot at once, so the boot below is the only keeper.
      keeper?.abort(new Error(PROTOCOL_ERRORS.FRAME_RESET));
      keep(0, config);
    }
  }

  function untilConfigured(): Promise<void> {
    return withTimeout(
      configured.promise,
      timeouts.configureMs,
      () => new Error(PROTOCOL_ERRORS.FRAME_UNCONFIGURED),
      timers,
    );
  }

  /** Runs `run` with the config, in the turn it is called once there is one, and never after a version mismatch. */
  function withConfig<T>(run: (config: ProtocolFrameConfig) => Promise<T>): Promise<T> {
    if (mismatch !== null) {
      return Promise.reject(mismatch);
    }
    if (frameConfig === null) {
      return untilConfigured().then(() => withConfig(run));
    }
    return run(frameConfig);
  }

  function whenReady(): Promise<ProtocolTransport> {
    return withConfig(config => {
      // Taken before the boot, since a frame that cannot be built fails in the same turn it is asked for. A loss from
      // before this call is what the boot answers, so it does not fail the wait.
      const since = losses;
      askForFrame(config);
      // Read when the status is reached, since the frame can be dropped before the wait's continuation runs.
      let reached: ProtocolTransport | null = null;
      return untilStatus(next => {
        if (next === 'ready') {
          reached = slot?.transport ?? null;
          return reached !== null || downReason;
        }
        return next === 'idle' || (next === 'failed' && losses > since) ? downReason : false;
      }).then(() => {
        if (reached === null) {
          throw downReason;
        }
        return reached;
      });
    });
  }

  function transport(): Promise<ProtocolTransport> {
    return withConfig(config => {
      askForFrame(config);
      // A keeper opens its slot in the turn it is asked for, so none here means its build failed at once.
      return slot === null ? Promise.reject(downReason) : Promise.resolve(slot.transport);
    });
  }

  return {
    getStatus: status.get,
    subscribeStatus: status.subscribe,
    configure(config) {
      const previous = frameConfig;
      frameConfig = { ...config };
      if (previous === null) {
        configured.resolve(undefined);
        return;
      }
      if (mismatch !== null || sameFrameConfig(previous, config) || status.get() === 'idle') {
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
      loseFrame(reason, 'idle');
      // A listener that heard `idle` may have asked for the frame already, and a second keeper would orphan one. It
      // may also have configured again, so the frame is built with the latest config.
      askForFrame(frameConfig);
    },
    transport,
    whenReady,
    onVersionMismatch(listener) {
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
    },
  };
}
