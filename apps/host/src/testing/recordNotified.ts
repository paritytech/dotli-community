// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onTestFinished } from 'vitest';
import type { ReadableStore } from '@dotli/shared';

/** Returns every value `store` notifies with, from now until the running test ends. Never throws. */
export function recordNotified<Value>(store: ReadableStore<Value>): Value[] {
  const notified: Value[] = [];
  onTestFinished(
    store.subscribe(() => {
      notified.push(store.get());
    }),
  );
  return notified;
}
