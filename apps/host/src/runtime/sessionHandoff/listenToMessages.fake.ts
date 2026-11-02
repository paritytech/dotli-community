// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { MessageEventLike } from './listenToMessages.js';

export type FakeWindowHandle = ReturnType<typeof createFakeWindowHandle>;

/** A window or opener in memory: set `closed` to stage a window the user closed, and read what was posted to it. */
export function createFakeWindowHandle() {
  const posted: { message: unknown; target: string }[] = [];
  const handle = {
    /** True once the user or the page closed the window. */
    closed: false,
    /** Every message posted to the window, in order, with its target origin. */
    posted,
    /** How many times the window was brought to the front. */
    focused: 0,
    /** How many times the page closed the window. */
    closedByPage: 0,
    /** Records `message` as posted to the `target` origin. */
    postMessage(message: unknown, target: string): void {
      posted.push({ message, target });
    },
    /** Counts one more bring to the front. */
    focus(): void {
      handle.focused += 1;
    },
    /** Closes the window, counted as closed by the page. */
    close(): void {
      handle.closedByPage += 1;
      handle.closed = true;
    },
  };
  return handle;
}

/** The page's `message` events in memory: `post` delivers one to every handler listening, and `size` counts them. */
export function createFakeMessageBus() {
  const handlers = new Set<(event: MessageEventLike) => void>();

  function listen(handler: (event: MessageEventLike) => void): () => void {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  function post(event: MessageEventLike): void {
    // A copy, so the handlers an event reaches are those listening when it was posted.
    for (const handler of [...handlers]) {
      handler(event);
    }
  }

  return {
    listen,
    post,
    get size() {
      return handlers.size;
    },
  };
}
