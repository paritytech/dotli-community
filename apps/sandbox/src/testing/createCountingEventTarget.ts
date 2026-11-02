// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createDeferred } from '@dotli/shared';

type Params = {
  /** The event type whose listeners are counted. */
  type: string;
};

/** An event target that counts the listeners for `type` still attached, so a spec can check each one is removed. */
export function createCountingEventTarget({ type }: Params) {
  const target = new EventTarget();
  const heard = createDeferred<undefined>();
  const listening = new Set<unknown>();

  return {
    /** Adds `args`' listener, counting it when it is for `type`. Never throws. */
    addEventListener,
    /** Removes `args`' listener, uncounting it when it is for `type`. Never throws. */
    removeEventListener,
    /** Dispatches `event` to the listeners for its type. Returns false when a listener cancelled it. */
    dispatchEvent: (event: Event): boolean => target.dispatchEvent(event),
    /** The listeners for `type` still attached. */
    countListening: (): number => listening.size,
    /** Resolves once a listener for `type` attaches. Never rejects. */
    listened: heard.promise,
  };

  function addEventListener(...args: Parameters<EventTarget['addEventListener']>): void {
    if (args[0] === type) {
      listening.add(args[1]);
      heard.resolve(undefined);
    }
    target.addEventListener(...args);
  }

  function removeEventListener(...args: Parameters<EventTarget['removeEventListener']>): void {
    if (args[0] === type) {
      listening.delete(args[1]);
    }
    target.removeEventListener(...args);
  }
}
