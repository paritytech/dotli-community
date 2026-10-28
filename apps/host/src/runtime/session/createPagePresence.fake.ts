// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SharedChannel } from '../sharedMode.js';
import type { Presence, SessionPresence } from './types.js';

export type FakeSessionPresence = {
  /** What the next read answers. A set makes it present and a clear absent. */
  state: Presence;
  /** Every call made, in order. */
  readonly calls: ('read' | 'set' | 'clear' | 'renew')[];
} & SessionPresence;

/** An in-memory presence: set the `state` to stage a read, and read `calls` to see what a flow did. Never rejects. */
export function createFakeSessionPresence(state: Presence = 'absent'): FakeSessionPresence {
  const fake: FakeSessionPresence = {
    state,
    calls: [],
    read() {
      fake.calls.push('read');
      return Promise.resolve(fake.state);
    },
    set() {
      fake.calls.push('set');
      fake.state = 'present';
      return Promise.resolve();
    },
    clear() {
      fake.calls.push('clear');
      fake.state = 'absent';
      return Promise.resolve();
    },
    renew() {
      fake.calls.push('renew');
      return Promise.resolve();
    },
  };
  return fake;
}

/** The dev store getter of a deployed page, where nothing serves one. Always throws. */
export function getUnservedChannel(): SharedChannel {
  throw new Error('no dev store on a deployed page');
}
