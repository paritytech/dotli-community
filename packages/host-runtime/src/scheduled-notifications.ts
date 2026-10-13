// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Any tab on the product origin fires a past-due record. The atomic IDB delete claims it, while the
// Web Lock only avoids redundant work. A hidden tab lags by an offset so a visible sibling wins the lock.

import {
  schedule as dbSchedule,
  cancel as dbCancel,
  allocateId,
  listAll,
  removeById,
  removeStale,
  isExpectedDbError,
  type ScheduledNotificationRecord,
} from '@dotli/storage';
import { SCHEDULED_NOTIFICATIONS_HIDDEN_TAB_OFFSET_MS, SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS } from '@dotli/config';
import { captureException, recordExpected } from '@dotli/metrics';
import { createAsyncTaskPool, log } from '@dotli/shared';
import type { HostNotice } from './host-prompts.js';

export type ScheduleNotificationResult =
  { ok: true; id: number; immediate: boolean } | { ok: false; error: 'ScheduleLimitReached' };

interface InitOpts {
  /** Only tags log lines. */
  label: string;
}

interface ScheduleRequest {
  productId: string;
  title: string;
  text: string;
  deeplink: string | null;
  scheduledAt: number | null;
}

export interface ScheduledNotificationStore {
  schedule: typeof dbSchedule;
  cancel: typeof dbCancel;
  allocateId: typeof allocateId;
  listAll: typeof listAll;
  removeById: typeof removeById;
  removeStale: (now: number) => Promise<number>;
}

export interface ScheduledNotificationsDeps {
  store: ScheduledNotificationStore;
  show: (notice: HostNotice) => void;
  /** Undefined where the browser has no Web Locks. */
  locks: Pick<LockManager, 'request'> | undefined;
  /** Null where the browser has no BroadcastChannel. */
  openChannel: (name: string) => BroadcastChannel | null;
  /** The document, whose visibility sets how late a due notification may show. */
  visibility: EventTarget & { readonly visibilityState: DocumentVisibilityState };
  /** The window, whose `pagehide` stops the poller. */
  lifecycle: EventTarget;
}

export interface ScheduledNotifications {
  /** Idempotent. */
  init: (opts: InitOpts) => void;
  /** An immediate fire (null or past `scheduledAt`) only allocates an id and is not persisted. */
  schedule: (req: ScheduleRequest) => Promise<ScheduleNotificationResult>;
  /** Idempotent. False when the record had already fired or never existed. */
  cancel: (productId: string, perProductId: number) => Promise<boolean>;
}

const BROADCAST_CHANNEL_NAME = 'dotli:scheduled-notifications';
type WakeMessage = { kind: 'scheduled' } | { kind: 'cancelled' } | { kind: 'fired'; hostId: number };

// The poller retries every second, so a failure is reported when it starts, not on every tick.
type PollStep = 'remove_stale' | 'list_pending' | 'claim';

export function createScheduledNotifications({
  store,
  show,
  locks,
  openChannel,
  visibility,
  lifecycle,
}: ScheduledNotificationsDeps): ScheduledNotifications {
  let initialized = false;
  let shuttingDown = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let bcChannel: BroadcastChannel | null = null;
  const failing = new Set<PollStep>();
  // One claim per record at a time. A claim that queued behind another finds the record gone and fires nothing.
  const claims = createAsyncTaskPool({ poolSize: 1 });

  const succeeded = (step: PollStep): void => {
    failing.delete(step);
  };

  const failed = (step: PollStep, err: unknown): void => {
    // The connection closes as the page unloads, so a tick caught by it is moot.
    if (shuttingDown || failing.has(step)) {
      return;
    }
    failing.add(step);
    if (isExpectedDbError(err)) {
      recordExpected(err, { flow: 'notifications', step });
      return;
    }
    log.error(`[scheduled notifications] ${step} failed:`, err);
    captureException(err, { flow: 'notifications', step });
  };

  /** Null when listing failed. */
  const pendingRecords = async (): Promise<ScheduledNotificationRecord[] | null> => {
    try {
      await store.removeStale(Date.now());
      succeeded('remove_stale');
    } catch (err) {
      failed('remove_stale', err);
    }

    try {
      const records = await store.listAll();
      succeeded('list_pending');
      return records;
    } catch (err) {
      failed('list_pending', err);
      return null;
    }
  };

  const fire = (rec: ScheduledNotificationRecord, source: 'realtime' | 'rehydrate'): void => {
    show({
      label: rec.title,
      text: rec.text,
      deeplink: rec.deeplink ?? undefined,
      // An OS toast for an event the user was not around for is intrusive.
      browserNotification: source === 'realtime',
    });
  };

  const claim = async (rec: ScheduledNotificationRecord, source: 'realtime' | 'rehydrate'): Promise<void> => {
    const claimAndFire = async (): Promise<void> => {
      const removed = await store.removeById(rec.hostId);
      if (!removed) {
        return;
      }
      fire(rec, source);
      bcChannel?.postMessage({
        kind: 'fired',
        hostId: rec.hostId,
      } satisfies WakeMessage);
    };

    try {
      if (locks !== undefined) {
        await locks.request(`dotli-notif:${String(rec.hostId)}`, { ifAvailable: true }, async lock => {
          if (!lock) {
            return;
          }
          await claimAndFire();
        });
      } else {
        // The IDB delete still claims the record alone.
        await claimAndFire();
      }
      succeeded('claim');
    } catch (err) {
      failed('claim', err);
    }
  };

  const tryFire = (rec: ScheduledNotificationRecord, source: 'realtime' | 'rehydrate'): Promise<void> =>
    claims.call(() => claim(rec, source), { pool: String(rec.hostId) });

  const stopPolling = (): void => {
    if (pollTimer === null) {
      return;
    }
    clearInterval(pollTimer);
    pollTimer = null;
  };

  const tick = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    const records = await pendingRecords();
    if (records === null) {
      return;
    }

    if (records.length === 0) {
      stopPolling();
      return;
    }

    const isVisible = visibility.visibilityState === 'visible';
    const offset = isVisible ? 0 : SCHEDULED_NOTIFICATIONS_HIDDEN_TAB_OFFSET_MS;
    const cutoff = Date.now() - offset;

    for (const rec of records) {
      if (rec.scheduledAt > cutoff) {
        continue;
      }
      await tryFire(rec, 'realtime');
    }
  };

  const ensurePolling = (): void => {
    if (shuttingDown || pollTimer !== null) {
      return;
    }
    pollTimer = setInterval(() => {
      void tick();
    }, SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS);
  };

  const rehydrate = async (): Promise<void> => {
    const records = await pendingRecords();
    const now = Date.now();
    for (const rec of records ?? []) {
      if (rec.scheduledAt > now) {
        continue;
      }
      await tryFire(rec, 'rehydrate');
    }
  };

  return {
    init: opts => {
      if (initialized) {
        return;
      }
      initialized = true;

      bcChannel = openChannel(BROADCAST_CHANNEL_NAME);
      if (bcChannel !== null) {
        bcChannel.onmessage = () => {
          ensurePolling();
        };
      }

      log.debug(`[${opts.label}] scheduled notifications: init`);

      void rehydrate().then(() => {
        ensurePolling();
      });

      visibility.addEventListener('visibilitychange', () => {
        if (visibility.visibilityState === 'visible') {
          ensurePolling();
        }
      });

      // IDB starts closing as unload begins, so a later tick throws `InvalidStateError`. `pagehide`, not
      // `beforeunload`, because it also fires on the bfcache path.
      lifecycle.addEventListener('pagehide', () => {
        shuttingDown = true;
        stopPolling();
        bcChannel?.close();
        bcChannel = null;
      });
    },

    schedule: async req => {
      const now = Date.now();

      if (req.scheduledAt === null || req.scheduledAt <= now) {
        const id = await store.allocateId(req.productId);
        return { ok: true, id, immediate: true };
      }

      const result = await store.schedule({
        productId: req.productId,
        title: req.title,
        text: req.text,
        deeplink: req.deeplink,
        scheduledAt: req.scheduledAt,
      });

      if (!result.ok) {
        return result;
      }

      ensurePolling();
      bcChannel?.postMessage({ kind: 'scheduled' } satisfies WakeMessage);

      return { ok: true, id: result.id, immediate: false };
    },

    cancel: async (productId, perProductId) => {
      const removed = await store.cancel(productId, perProductId);
      if (removed) {
        bcChannel?.postMessage({ kind: 'cancelled' } satisfies WakeMessage);
      }
      return removed;
    },
  };
}

/** The page's scheduler, over the dotli database, the browser's locks and channels, and this document. */
export function createPageScheduledNotifications(show: (notice: HostNotice) => void): ScheduledNotifications {
  return createScheduledNotifications({
    store: { schedule: dbSchedule, cancel: dbCancel, allocateId, listAll, removeById, removeStale },
    show,
    locks: 'locks' in navigator ? navigator.locks : undefined,
    openChannel: name => (typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null),
    visibility: document,
    lifecycle: window,
  });
}
