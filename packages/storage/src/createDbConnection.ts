// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createAsyncTaskPool } from '@dotli/shared';

type Params = {
  /** Opens the database, and rejects when it cannot. */
  open: () => Promise<IDBDatabase>;
};

/**
 * One connection shared by every read, opened by `open` on first use. A connection that closes, or that another tab's
 * upgrade asks to close, is dropped, and a failed open is not retried: the next read opens again, which is when it can
 * succeed.
 */
export function createDbConnection({ open }: Params): () => Promise<IDBDatabase> {
  let current: IDBDatabase | null = null;
  // Reads that overlap an open wait for it instead of opening their own.
  const opens = createAsyncTaskPool({ poolSize: 1 });

  async function getOrOpen(): Promise<IDBDatabase> {
    if (current !== null) {
      return current;
    }
    const db = await open();
    current = db;
    // Only this handle's own close drops it, so a late close of a replaced one keeps the newer.
    function release(): void {
      if (current === db) {
        current = null;
      }
    }
    db.onclose = release;
    db.onversionchange = () => {
      db.close();
      release();
    };
    return db;
  }

  return () => opens.call(getOrOpen);
}
