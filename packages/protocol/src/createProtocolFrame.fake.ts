// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A protocol frame without an iframe, for the layers above it. Each frame it builds is a real transport over an
// in-memory provider pair, with a real transport on the far side the test answers through. The test says when the
// frame is up and when it is lost. A frame's transport is handed out only once the test says it listens, as a real
// frame hands out its transport once its iframe loads, since a call starts the handshake. So calls made while it boots
// wait as they would on a real frame.

import { atom } from 'nanostores';
import { realTimers, waitForStatus, type Timers } from '@dotli/shared';
import { createTransport } from '@dotli/transport';
import { createProviderPair } from '@dotli/transport/testing';
import type { ProtocolFrame, ProtocolStatus } from './frameTypes.js';
import { protocolSchema, type ProtocolTransport } from './schema.js';

export type FakeFrame = ReturnType<typeof createFakeFrame>;

type Params = {
  /** Sets up each frame's serving transport as it is built. */
  serve?: (serving: ProtocolTransport) => void;
  /** Where the frame stands at first. */
  status?: ProtocolStatus;
  /** What each frame's transport waits on. */
  timers?: Timers;
};

type Built = {
  /** The host's side. */
  host: ProtocolTransport;
  /** The frame app's side, which serves the host. */
  serving: ProtocolTransport;
};

/**
 * Up and ready unless `status` says otherwise, or the test moves it. A `waitUntilReady` or `getTransport` on an idle or
 * failed frame builds one and starts it booting, as the frame does. A `getTransport` waits for the test to set
 * `listening` or `ready`, and a `waitUntilReady` for `ready`. Each fails when the frame is then lost or goes idle.
 * Unlike the frame, a status listener's throw reaches the test through the call that moved the status.
 */
export function createFakeFrame({
  serve = () => undefined,
  status: initial = 'ready',
  timers = realTimers,
}: Params = {}) {
  const status = atom<ProtocolStatus>(initial);
  const storeHeld = atom(false);
  let lostWith: Error = new Error('lost');
  let builds = 0;
  let current: Built | null = null;
  const checks: ProtocolTransport[] = [];

  function build(): Built {
    builds += 1;
    const { left, right } = createProviderPair();
    const hello = { resolutionId: null };
    const serving = createTransport({ schema: protocolSchema, provider: right, handshake: 'respond', hello });
    serve(serving);
    return {
      host: createTransport({ schema: protocolSchema, provider: left, handshake: 'offer', hello, timers }),
      serving,
    };
  }

  /** Builds a frame for a status that is up if there is none, and connects it once it listens. */
  function bringUp(next: ProtocolStatus): void {
    switch (next) {
      case 'idle':
      case 'failed':
        return;
      case 'booting':
        current ??= build();
        return;
      case 'listening':
      case 'ready':
        current ??= build();
        current.host.connect();
        return;
    }
  }

  function setStatus(next: ProtocolStatus): void {
    bringUp(next);
    status.set(next);
  }

  function boot(): Built {
    if (isDown(status.get())) {
      setStatus('booting');
    }
    current ??= build();
    return current;
  }

  /** The host's side of the frame there is once the status is one of `reached`, booting one if there is none. */
  function waitForHost(reached: readonly ProtocolStatus[]): Promise<ProtocolTransport> {
    boot();
    let host: ProtocolTransport | null = null;
    return waitForStatus(status, next => {
      if (reached.includes(next)) {
        host = current?.host ?? null;
        return host !== null || lostWith;
      }
      switch (next) {
        case 'failed':
          return lostWith;
        case 'idle':
          return new Error('frame went idle');
        case 'booting':
        case 'listening':
        case 'ready':
          return false;
      }
    }).then(() => {
      if (host === null) {
        throw lostWith;
      }
      return host;
    });
  }

  function lose(error: Error): void {
    lostWith = error;
    const lost = current;
    current = null;
    setStatus('failed');
    lost?.host.dispose(error);
    lost?.serving.dispose(error);
  }

  bringUp(status.get());

  const frame: ProtocolFrame = {
    status,
    storeHeld,
    configure: () => undefined,
    getTransport: () => waitForHost(['listening', 'ready']),
    waitUntilReady: () => waitForHost(['ready']),
    // The facades never read it, and this fake's frame speaks the host's schema.
    onVersionMismatch: () => () => undefined,
    checkAlive: transport => {
      checks.push(transport);
    },
  };

  return {
    /** The frame the layers above it are built on. */
    frame,
    /** Moves the frame to `status`. Up, it builds a frame if there is none, and `listening` and `ready` connect it. */
    setStatus,
    /** Drops the frame with `error`, after its status says it is down. Its transport is disposed with `error`. */
    lose,
    /** Says whether a frame whose light client failed to start is held for the store. Builds and drops nothing. */
    holdStore: (held: boolean): void => {
      storeHeld.set(held);
    },
    /** How many frames were built. */
    countBuilds: () => builds,
    /** The transports the frame was asked to check, in order. Checks nothing. */
    checks,
  };
}

/** A frame that is down has nothing to hear. */
function isDown(status: ProtocolStatus): boolean {
  switch (status) {
    case 'idle':
    case 'failed':
      return true;
    case 'booting':
    case 'listening':
    case 'ready':
      return false;
  }
}
