// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createAsyncTaskPool } from '@dotli/shared';

/**
 * Loads a chunk once for the page and keeps it. A failed load is forgotten, so the next call loads again, and a
 * transient fetch failure is fixed by a retry rather than a reload.
 */
export function createRuntimeLoader<T>(load: () => Promise<T>): () => Promise<T> {
  // One load at a time, so callers that overlap a load wait for it and then find it kept.
  const pool = createAsyncTaskPool({ poolSize: 1 });
  let loaded: { value: T } | undefined;
  return () =>
    pool.call(async () => {
      loaded ??= { value: await load() };
      return loaded.value;
    });
}
