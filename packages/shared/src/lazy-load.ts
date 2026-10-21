// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createAsyncTaskPool } from './async-task-pool.js';

/**
 * Loads a value on the first call and keeps it for every later one. A failed load rejects the caller that ran it and is
 * not kept, so the next caller, queued behind it or later, loads again itself. `onFirstMiss` hears the first failure
 * of this loader only, so a chunk a deploy removed is reported once.
 */
export function createLazyLoad<T>(
  load: () => Promise<T>,
  options: { onFirstMiss?: (err: unknown) => void } = {},
): () => Promise<T> {
  // One load at a time, so callers that overlap a load wait for it and then find it kept, in the order they asked.
  const loads = createAsyncTaskPool({ poolSize: 1 });
  // Boxed, so a loaded `null` or `undefined` is kept too.
  let loaded: { value: T } | undefined;
  let missed = false;
  const loadOnce = async (): Promise<T> => {
    if (loaded !== undefined) {
      return loaded.value;
    }
    try {
      loaded = { value: await load() };
      return loaded.value;
    } catch (err: unknown) {
      if (!missed) {
        missed = true;
        options.onFirstMiss?.(err);
      }
      throw err;
    }
  };
  return () => loads.call(loadOnce);
}
