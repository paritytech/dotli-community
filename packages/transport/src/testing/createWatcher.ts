// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Listener bookkeeping for tests of a subscription.

import type { ResultPayload } from 'scale-ts';
import type { Failure } from '../failure.js';

/**
 * Listeners of a subscription whose values are text and whose interrupt is `Interrupt`, such as `notes.watch`, that
 * record the values it hears, its interrupts, its failures and its closes.
 */
export function createWatcher<Interrupt = ResultPayload<undefined, string>>() {
  const values: string[] = [];
  const ends: Interrupt[] = [];
  const fails: Failure[] = [];
  const closes: Error[] = [];
  return {
    values,
    ends,
    fails,
    closes,
    receive: (value: string) => {
      values.push(value);
    },
    interrupt: (reason: Interrupt) => {
      ends.push(reason);
    },
    fail: (failure: Failure) => {
      fails.push(failure);
    },
    close: (error: Error) => {
      closes.push(error);
    },
  };
}
