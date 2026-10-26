// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { MessageEventLike, WindowHandle } from './messages.js';

export interface FakeWindowHandle extends WindowHandle {
  closed: boolean;
  readonly posted: { message: unknown; target: string }[];
  focused: number;
  closedByPage: number;
}

/** A window or opener in memory: set `closed` to stage a window the user closed, and read what was posted to it. */
export function createFakeWindowHandle(): FakeWindowHandle {
  const handle: FakeWindowHandle = {
    closed: false,
    posted: [],
    focused: 0,
    closedByPage: 0,
    postMessage: (message, target) => {
      handle.posted.push({ message, target });
    },
    focus: () => {
      handle.focused += 1;
    },
    close: () => {
      handle.closedByPage += 1;
      handle.closed = true;
    },
  };
  return handle;
}

export interface FakeMessageBus {
  listen: (handler: (event: MessageEventLike) => void) => () => void;
  post: (event: MessageEventLike) => void;
  readonly size: number;
}

/** The page's `message` events in memory: `post` delivers one to every handler listening, and `size` counts them. */
export function createFakeMessageBus(): FakeMessageBus {
  const handlers = new Set<(event: MessageEventLike) => void>();
  return {
    listen: handler => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    post: event => {
      // A copy, so the handlers an event reaches are those listening when it was posted.
      for (const handler of [...handlers]) {
        handler(event);
      }
    },
    get size() {
      return handlers.size;
    },
  };
}
