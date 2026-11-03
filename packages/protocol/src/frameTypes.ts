// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The protocol frame's contract, and the status, config, timeouts and page parts it is built with.

import type { Backend, Network } from '@dotli/config';
import type { m } from '@dotli/metrics';
import type { Timers } from '@dotli/shared';
import type { MessageTarget, WindowLike } from '@dotli/transport';
import type { ProtocolVersionMismatchError } from './errors.js';
import type { ProtocolTransport } from './schema.js';

/**
 * Where the protocol frame stands. `idle` before anything asked for it. `booting` while it loads. `listening` once it
 * answered the handshake, so it answers shared store requests, which in SharedWorker mode is long before its light
 * client is `ready`. `failed` while it is down, until a rebuild boots, either the frame's own after a backoff or one a
 * caller asked for, and for good after a version mismatch.
 */
export type ProtocolStatus = 'idle' | 'booting' | 'listening' | 'ready' | 'failed';

/** What the frame is built with. A change rebuilds it. */
export type ProtocolFrameConfig = {
  /** What the frame serves chains with. */
  backend: Backend;
  /** The network the frame connects to. */
  network: Network;
  /** Asks the frame to purge its IndexedDB caches first, forcing a cold start. */
  skipWorkerCache: boolean;
};

/** How long each step of the frame's lifecycle may take. */
export type ProtocolFrameTimeouts = {
  /** A wait begun before the first config, so a page that never configures the frame fails its requests. */
  configureMs: number;
  /** The frame document loads. */
  loadMs: number;
  /** The frame answers the handshake once loaded. */
  handshakeMs: number;
  /**
   * The light client reports ready. In SharedWorker mode that waits on the worker's presync, so this outlasts the
   * presync's own deadline, or the host fails a boot the worker would still finish.
   */
  readyMs: number;
  /** The first wait before a lost frame is rebuilt. It doubles after each rebuild that does not stay up. */
  rebuildMs: number;
  /** The longest wait between rebuilds. */
  maxRebuildMs: number;
  /** A frame ready this long has recovered, so losing it starts the waits over. */
  stableMs: number;
};

/**
 * The hidden iframe, as much of it as the frame uses. An `HTMLIFrameElement` is one. Each member is the element's own.
 */
export type FrameElement = {
  src: string;
  tabIndex: number;
  readonly style: { cssText: string };
  readonly contentWindow: WindowLike | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: 'load' | 'error', listener: () => void, options: { once: true }): void;
  removeEventListener(type: 'load' | 'error', listener: () => void): void;
  remove(): void;
};

/**
 * Builds and mounts the hidden frame's iframe, an `E`. The page's `document` in the browser. Each member is the
 * document's own.
 */
export type FrameDocument<E extends FrameElement> = {
  createElement(tagName: 'iframe'): E;
  readonly body: { appendChild(node: E): E };
};

/** What a protocol frame is built on. */
export type ProtocolFrameParams<E extends FrameElement> = {
  /** The protocol frame's origin. Messages from any other origin are ignored. */
  origin: string;
  /** Where the frame's iframe is built and mounted. */
  document: FrameDocument<E>;
  /** Where the frame's messages arrive. The page's `window` in the browser. */
  window: MessageTarget;
  /** Overrides of the default lifecycle timeouts. */
  timeouts?: Partial<ProtocolFrameTimeouts> | undefined;
  /** The clock the lifecycle waits run on. The real one when unset. */
  timers?: Timers | undefined;
  /** Counts the frame's outcomes. The shared metrics' when unset. */
  count?: typeof m.count | undefined;
};

/** The protocol frame as the layers above it use it. */
export type ProtocolFrame = {
  /** Where the frame stands now. */
  getStatus(): ProtocolStatus;
  /**
   * Called on each change only, with the status there is when its turn comes, so within one round of listeners it can
   * hear the same status twice and miss one. Does not start a frame. Returns the unsubscribe.
   */
  subscribeStatus(listener: (status: ProtocolStatus) => void): () => void;
  /**
   * Says what the frame is built with. Nothing boots before it, and waits begun before the first config wait for it,
   * up to `configureMs`.
   * The same config again does nothing. A different one rebuilds a frame already asked for at once, unless a frame
   * refused the host's wire version, which no rebuild fixes. Throws only what a status listener throws, after every
   * listener heard the change.
   */
  configure(config: ProtocolFrameConfig): void;
  /**
   * The transport of the frame there is now, booting one if there is none, once the frame is configured and its iframe
   * has loaded, since a call starts the handshake and a frame hears none before its document loads. Rejects with the
   * loss when the frame is dropped before it loads. Calls on it wait in its queue until its handshake succeeds, and
   * fail with the loss when the frame is dropped first. Rejects with the version mismatch for good once a frame refused
   * the host's wire. The transport itself speaks the transport library's outcomes and errors, so a failed handshake
   * rejects its calls with the library's timeout or mismatch error.
   */
  getTransport(): Promise<ProtocolTransport>;
  /**
   * The transport of the ready frame, booting one if none was asked for yet, once it is configured. A call while the
   * frame is down boots one at once instead of waiting out the rebuild backoff, and calls that find a boot under way
   * join it. Rejects with why when the boot it waits on fails, or when a config change drops the frame, so no caller is
   * left to its own timeout. A status listener queued ahead of it that asks for the rebuilt frame on the change keeps it
   * waiting on that frame instead.
   */
  waitUntilReady(): Promise<ProtocolTransport>;
  /**
   * Hears the version mismatch that left the frame down for good, once, and at once if it already did. A frame rebuilt
   * while an app is open can come from a newer release, and only a reload fixes that. Returns the unsubscribe.
   */
  onVersionMismatch(listener: (error: ProtocolVersionMismatchError) => void): () => void;
};
