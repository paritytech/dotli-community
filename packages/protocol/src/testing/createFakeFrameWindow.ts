// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The window delivers on a microtask and moves each transferred buffer, as a browser does.

import { FRAME_ORIGIN, HOST_ORIGIN } from './constants.js';
import type { Listener } from './types.js';

/** The frame's window: the host posts to it, and the frame listens on it and posts to its parent. */
export type FakeFrameWindow = ReturnType<typeof createFakeFrameWindow>;

type Params = {
  /** Hears each post the frame makes to its parent. */
  toHost: Listener;
};

/** A window whose posts reach `toHost` from the frame, and which hears the host's posts as the frame does. */
export function createFakeFrameWindow({ toHost }: Params) {
  const listeners = new Set<Listener>();
  const posted: unknown[] = [];
  const sent: unknown[] = [];
  const parent = {
    postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void {
      if (targetOrigin !== HOST_ORIGIN) {
        return;
      }
      const data = cloneMoved(message, transfer);
      sent.push(data);
      queueMicrotask(() => {
        toHost({ data, origin: FRAME_ORIGIN, source: frameWindow });
      });
    },
  };

  const frameWindow = {
    /** Everything the host posted, in order, as the frame received it. */
    get posted() {
      return posted;
    },
    /** Everything the frame posted to the host, in order, as the host received it. */
    get sent() {
      return sent;
    },
    /** The host page as the frame sees it. A post reaches the host's listeners with this window as the source. */
    get parent() {
      return parent;
    },
    /** Hands `message` to the frame's listeners on a microtask, unless `targetOrigin` is not the frame's. */
    postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void {
      const data = cloneMoved(message, transfer);
      posted.push(data);
      // A browser drops a message whose target origin is not the window's.
      if (targetOrigin !== FRAME_ORIGIN) {
        return;
      }
      queueMicrotask(() => {
        for (const listener of [...listeners]) {
          listener({ data, origin: HOST_ORIGIN, source: parent });
        }
      });
    },
    /** Starts delivering the host's posts to `listener`. */
    addEventListener(_type: 'message', listener: Listener): void {
      listeners.add(listener);
    },
    /** Stops delivering the host's posts to `listener`. */
    removeEventListener(_type: 'message', listener: Listener): void {
      listeners.delete(listener);
    },
  };
  return frameWindow;
}

/** What a transfer leaves the receiver. The sender's buffer is detached, so posting it again fails as in a browser. */
function cloneMoved(data: unknown, transfer: Transferable[] | undefined): unknown {
  return transfer === undefined || transfer.length === 0 ? data : structuredClone(data, { transfer });
}
