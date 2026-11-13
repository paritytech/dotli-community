// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { scheduledNotifications, ScheduledNotificationRecord } from '@dotli/storage';

type Params = {
  /** Where the record persists. */
  store: Pick<typeof scheduledNotifications, 'removeById'>;
  /** Undefined where the browser has no Web Locks. */
  locks: Pick<LockManager, 'request'> | undefined;
  /** The due record to claim. */
  record: ScheduledNotificationRecord;
  /** Once it aborts, the record is left in the store. */
  signal: AbortSignal;
};

/**
 * Removes `record` from the store, under its lock where the browser has Web Locks. The atomic delete is what claims it,
 * while the lock only spares a sibling tab redundant work. Resolves whether this tab removed it. Rejects with
 * `signal`'s reason once it aborted, and when the store cannot remove it.
 */
export function claimScheduledNotification({ store, locks, record, signal }: Params): Promise<boolean> {
  if (locks === undefined) {
    return removeRecord();
  }
  return locks.request(`dotli-notif:${String(record.hostId)}`, { ifAvailable: true }, async lock => {
    if (lock === null) {
      return false;
    }
    return removeRecord();
  });

  async function removeRecord(): Promise<boolean> {
    // A disposed scheduler leaves the record in the store for another tab or the next load to fire.
    signal.throwIfAborted();
    return store.removeById(record.hostId);
  }
}
