// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The hidden protocol iframe: it boots on demand, publishes where it stands, rebuilds itself when it is lost, and is
// the only listener for its messages.

import type { Backend, Network } from '@dotli/config';
import { getResolutionId, m, reportListener, spans as S } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  createStatusCell,
  errorName,
  log,
  serializeError,
  toError,
  withTimeout,
} from '@dotli/shared';
import { PROTOCOL_ERRORS, ProtocolFatalError, ProtocolInitFailedError } from './errors.js';
import { protocolListeners } from './listeners.js';
import { isProtocolEnvelope, type ProtocolEnvelope } from './messages.js';

/**
 * Where the protocol frame stands. `idle` before anything asked for it. `booting` while it loads. `listening` once it
 * answers shared store requests, which in SharedWorker mode is long before its light client is `ready`. `failed`
 * while it is down, until a rebuild boots, either the frame's own after a backoff or one a caller asked for.
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
  return (Object.keys(FRAME_MODES) as Backend[]).find(backend => FRAME_MODES[backend] === mode) ?? null;
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
  /** The frame document loads. */
  loadMs: number;
  /** Module scripts run before `load`, so a frame whose listeners are not bound this long after it is not booting. */
  listenMs: number;
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
  listenMs: 5_000,
  readyMs: 240_000,
  rebuildMs: 2_000,
  maxRebuildMs: 30_000,
  stableMs: 30_000,
};

/** Where the frame's messages arrive. The page's `window` in the browser. */
export interface MessageTarget {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** Builds and mounts the hidden frame. The page's `document` in the browser. */
export interface FrameDocument {
  createElement(tagName: 'iframe'): HTMLIFrameElement;
  readonly body: HTMLElement;
}

export interface ProtocolFrameDeps {
  /** The protocol frame's origin. Messages from any other origin are ignored. */
  origin: string;
  document: FrameDocument;
  window: MessageTarget;
  timeouts?: Partial<ProtocolFrameTimeouts> | undefined;
}

export interface ProtocolFrame {
  getStatus(): ProtocolStatus;
  /** Called on each change only. Does not start a frame. */
  subscribeStatus(listener: (status: ProtocolStatus) => void): () => void;
  /**
   * Says what the frame is built with. Nothing boots before it, and waits begun before the first config wait for it,
   * up to `configureMs`.
   * The same config again does nothing. A different one rebuilds a frame already asked for at once.
   */
  configure(config: ProtocolFrameConfig): void;
  /**
   * Resolves once the frame has reached `wanted`, booting one if none was asked for yet, once it is configured. A call
   * while the frame is down boots one at once instead of waiting out the rebuild backoff, and calls that find a boot
   * under way join it. Rejects with why when the boot it waits on fails, or when a config change drops the frame, so
   * no caller is left to its own timeout.
   */
  whenUp(wanted: 'listening' | 'ready'): Promise<void>;
  /** Posts to the frame there is now, or throws when there is none. */
  post(message: unknown): void;
  /** Hears every message the current frame sends, after its origin and sender are checked. */
  onEnvelope(listener: (envelope: ProtocolEnvelope) => void): () => void;
  /**
   * Hears why each frame was dropped, after the status changed, so a listener that asks again finds it down and boots a
   * new frame at once.
   */
  onLost(listener: (error: Error) => void): () => void;
  /**
   * How many frames were dropped so far. Counted before the status changes, so work a status listener starts on the
   * drop can tell itself apart from the work `onLost` is about.
   */
  losses(): number;
}

interface FrameSlot {
  readonly iframe: HTMLIFrameElement;
  /** Aborted with why the frame is gone, which ends whatever its keeper waits on. */
  readonly loss: AbortController;
}

function sameFrameConfig(a: ProtocolFrameConfig, b: ProtocolFrameConfig): boolean {
  return a.backend === b.backend && a.network === b.network && a.skipWorkerCache === b.skipWorkerCache;
}

/** The frame's step that failed, so a failure is counted where it happened. */
type BootPhase = 'load' | 'listen' | 'ready';

function reportBootFailure(phase: BootPhase, error: unknown): void {
  m.count(S.PROTOCOL_IFRAME_READY, { outcome: 'error', phase, reason: errorName(error) ?? 'unknown' });
  m.breadcrumb(phase === 'ready' ? 'protocol iframe ready wait failed' : 'protocol iframe load failed', {
    reason: serializeError(error),
  });
  log.error(
    phase === 'ready' ? '[dot.li protocol] Ready wait failed:' : '[dot.li protocol] Host iframe load failed:',
    error,
  );
}

export function createProtocolFrame(deps: ProtocolFrameDeps): ProtocolFrame {
  const { origin, document: frameDocument, window: messages } = deps;
  const timeouts: ProtocolFrameTimeouts = { ...DEFAULT_FRAME_TIMEOUTS, ...deps.timeouts };

  const status = createStatusCell<ProtocolStatus>('idle', {
    onListenerError: reportListener('protocol', 'protocol.status'),
  });
  const envelopeListeners = protocolListeners<ProtocolEnvelope>('envelope');
  const lostListeners = protocolListeners<Error>('frame_lost');
  // Why the frame is down, for a caller that asks before it is back.
  let downReason: Error = new Error(PROTOCOL_ERRORS.FRAME_RESET);
  // The frame being booted or kept, and nothing while the frame is down.
  let slot: FrameSlot | null = null;
  // Stops the keeper when the host drops the frame on purpose.
  let keeper: AbortController | null = null;
  let losses = 0;

  let frameConfig: ProtocolFrameConfig | null = null;
  let resolveConfigured: () => void = () => undefined;
  const configured = new Promise<void>(resolve => {
    resolveConfigured = resolve;
  });

  // One task keeps the frame. It retries without end, each wait doubling, and settles only when a frame it kept
  // stable is lost.
  const frameKeeper = createAsyncTaskPool({
    poolSize: 1,
    retryCount: Number.POSITIVE_INFINITY,
    retryDelay: retry => Math.min(timeouts.rebuildMs * 2 ** retry, timeouts.maxRebuildMs),
  });

  const setStatus = status.set;

  function loseFrame(error: Error, next: 'failed' | 'idle'): void {
    const lost = slot;
    slot = null;
    downReason = error;
    losses += 1;
    if (lost !== null) {
      lost.loss.abort(error);
      lost.iframe.remove();
    }
    setStatus(next);
    lostListeners.emit(error);
  }

  function onMessage(event: MessageEvent): void {
    if (!isProtocolEnvelope(event.data)) {
      return;
    }

    if (event.origin !== origin) {
      return;
    }

    // With no frame there is nothing legitimate to hear, and a late message from a dropped one must not fail the next.
    if (slot === null) {
      return;
    }
    const frameWindow = slot.iframe.contentWindow;
    if (frameWindow !== null && event.source !== frameWindow) {
      return;
    }

    const msg = event.data;
    if (msg.kind === 'listening' && status.get() === 'booting') {
      setStatus('listening');
    } else if (msg.kind === 'ready') {
      setStatus('ready');
    } else if (msg.kind === 'fatal' || msg.kind === 'init-failed') {
      // Smoldot or the iframe died, so nothing will answer any request in flight.
      const kind = msg.kind === 'fatal' ? 'Fatal' : 'Init failed';
      log.error(`[dot.li protocol] ${kind}: ${msg.message}`);
      const err =
        msg.kind === 'fatal'
          ? new ProtocolFatalError(`${kind}: ${msg.message}`)
          : new ProtocolInitFailedError(`${kind}: ${msg.message}`);

      // The keeper rebuilds it. A rebuild starts a new light client, and the protocol page is served uncached so after
      // a deploy it loads fresh chunks. An init failure a rebuild repeats is retried ever more slowly.
      loseFrame(err, 'failed');
    }
    envelopeListeners.emit(msg);
  }

  /**
   * Waits on the status until `verdict` settles the wait with `true` or fails it with an error, and fails with the
   * signal's reason when the frame is lost first. `start` begins whatever else the wait needs, such as a timer that
   * calls `fail`, and returns how to release it once the wait is over.
   */
  function untilStatus(
    verdict: (status: ProtocolStatus) => boolean | Error,
    signal?: AbortSignal,
    start?: (fail: (error: Error) => void) => () => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // A frame lost before the wait began leaves nothing to start.
      if (signal?.aborted === true) {
        reject(signal.reason as Error);
        return;
      }
      let release = (): void => undefined;
      let unsubscribe = (): void => undefined;
      // Widened, since `start` can settle the wait before it returns.
      let settled = false as boolean;
      const onStatus = (next: ProtocolStatus): void => {
        const outcome = verdict(next);
        if (outcome === true) {
          settle(null);
        } else if (outcome instanceof Error) {
          settle(outcome);
        }
      };
      const onAbort = (): void => {
        settle(signal?.reason as Error);
      };
      function settle(error: Error | null): void {
        if (settled) {
          return;
        }
        settled = true;
        release();
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
        if (error === null) {
          resolve();
        } else {
          reject(error);
        }
      }
      unsubscribe = status.subscribe(onStatus);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (start !== undefined) {
        release = start(settle);
        // A wait `start` already failed ran the release it had before this one.
        if (settled) {
          release();
          return;
        }
      }
      onStatus(status.get());
    });
  }

  function createIframe(config: ProtocolFrameConfig): HTMLIFrameElement {
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
   * Mounts the frame and resolves once its request listeners are bound, not on `load`, which also fires when its
   * script failed and would leave every request to its full timeout. `ready` counts too, since the frame binds before
   * init. The deadline restarts at `load`, since a loaded frame has only its listeners left to bind.
   */
  async function untilListening(iframe: HTMLIFrameElement, signal: AbortSignal): Promise<void> {
    let onLoad = (): void => undefined;
    const loaded = new Promise<void>(resolve => {
      onLoad = () => {
        resolve();
      };
    });
    iframe.addEventListener('load', onLoad, { once: true });
    const listening = untilStatus(
      next => next === 'listening' || next === 'ready',
      signal,
      fail => {
        const onError = (): void => {
          fail(new Error(PROTOCOL_ERRORS.HOST_FRAME_LOAD_FAILED));
        };
        iframe.addEventListener('error', onError, { once: true });
        frameDocument.body.appendChild(iframe);
        return () => {
          iframe.removeEventListener('error', onError);
        };
      },
    );
    try {
      await withTimeout(
        Promise.race([loaded, listening]),
        timeouts.loadMs,
        () => new Error(PROTOCOL_ERRORS.HOST_FRAME_LOAD_TIMEOUT),
      );
      await withTimeout(listening, timeouts.listenMs, () => new Error(PROTOCOL_ERRORS.HOST_FRAME_NOT_LISTENING));
    } finally {
      iframe.removeEventListener('load', onLoad);
    }
  }

  /**
   * Boots a frame and holds it until it is lost. Settles only when the lost frame had been ready for `stableMs`, so
   * a frame that never comes up, or dies soon after, is retried by the pool with ever longer waits.
   */
  async function keepFrame(run: AbortSignal, config: ProtocolFrameConfig): Promise<void> {
    const loss = new AbortController();
    let kept: FrameSlot | null = null;
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
      kept = { iframe, loss };
      slot = kept;
      await untilListening(iframe, loss.signal);
      phase = 'ready';
      const stopReady = m.timer(S.PROTOCOL_IFRAME_READY);
      try {
        await withTimeout(
          untilStatus(next => next === 'ready', loss.signal),
          timeouts.readyMs,
          () => new Error(PROTOCOL_ERRORS.FRAME_READY_TIMEOUT),
        );
      } finally {
        stopReady();
      }
      readyAt = Date.now();
      await untilStatus(() => false, loss.signal);
    } catch (error: unknown) {
      const reason = toError(error);
      // Still the frame, so this keeper found the failure, not a message or a config change.
      if (kept === null || slot === kept) {
        reportBootFailure(
          phase === 'load' && reason.message === PROTOCOL_ERRORS.HOST_FRAME_NOT_LISTENING ? 'listen' : phase,
          error,
        );
        loseFrame(reason, 'failed');
      }
      if (readyAt !== null && Date.now() - readyAt >= timeouts.stableMs) {
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
          // Still `config`, since a change aborts the run.
          if (!run.signal.aborted) {
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
    return withTimeout(configured, timeouts.configureMs, () => new Error(PROTOCOL_ERRORS.FRAME_UNCONFIGURED));
  }

  function whenUp(wanted: 'listening' | 'ready'): Promise<void> {
    if (frameConfig === null) {
      return untilConfigured().then(() => whenUp(wanted));
    }
    // Taken before the boot, since a frame that cannot be built fails in the same turn it is asked for. A loss from
    // before this call is what the boot answers, so it does not fail the wait.
    const since = losses;
    askForFrame(frameConfig);
    return untilStatus(next => {
      if (next === 'ready' || (wanted === 'listening' && next === 'listening')) {
        return true;
      }
      return next === 'idle' || (next === 'failed' && losses > since) ? downReason : false;
    });
  }

  messages.addEventListener('message', onMessage);

  return {
    getStatus: status.get,
    subscribeStatus: status.subscribe,
    configure(config) {
      const previous = frameConfig;
      frameConfig = { ...config };
      if (previous === null) {
        resolveConfigured();
        return;
      }
      if (sameFrameConfig(previous, config) || status.get() === 'idle') {
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
    whenUp,
    post(message) {
      const frameWindow = slot?.iframe.contentWindow;
      if (frameWindow === null || frameWindow === undefined) {
        throw new Error(PROTOCOL_ERRORS.FRAME_UNAVAILABLE);
      }
      frameWindow.postMessage(message, origin);
    },
    onEnvelope: envelopeListeners.subscribe,
    onLost: lostListeners.subscribe,
    losses: () => losses,
  };
}
