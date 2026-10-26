// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Presence, SessionPresence } from './presence.js';

export interface FakeSessionPresence extends SessionPresence {
  state: Presence;
  readonly calls: ('read' | 'set' | 'clear' | 'renew')[];
}

/** An in-memory presence: set the `state` to stage a read, and read `calls` to see what a flow did. */
export function createFakeSessionPresence(state: Presence = 'absent'): FakeSessionPresence {
  const fake: FakeSessionPresence = {
    state,
    calls: [],
    read: () => {
      fake.calls.push('read');
      return Promise.resolve(fake.state);
    },
    set: () => {
      fake.calls.push('set');
      fake.state = 'present';
      return Promise.resolve();
    },
    clear: () => {
      fake.calls.push('clear');
      fake.state = 'absent';
      return Promise.resolve();
    },
    renew: () => {
      fake.calls.push('renew');
      return Promise.resolve();
    },
  };
  return fake;
}
