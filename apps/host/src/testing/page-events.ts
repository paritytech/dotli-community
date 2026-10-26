// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A page event in memory for specs that stage a return to the page.

export interface FakePageEvents {
  subscribe: (listener: () => void) => () => void;
  fire: () => void;
  readonly size: number;
}

/** A page event in memory, such as a return to the page: `fire` calls every listener, and `size` counts them. */
export function createFakePageEvents(): FakePageEvents {
  const listeners = new Set<() => void>();
  return {
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    fire: () => {
      // A copy, so the listeners an event reaches are those subscribed when it fired.
      for (const listener of [...listeners]) {
        listener();
      }
    },
    get size() {
      return listeners.size;
    },
  };
}
