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
import { log } from '@dotli/shared';
import { findNotification } from '@dotli/storage/notification-activations';
import { notificationDeliveryIsCurrent, presentProductNotification } from './notification-activation.js';

export type ScheduleNotificationResult =
  { ok: true; id: number; immediate: boolean } | { ok: false; error: 'ScheduleLimitReached' };

interface InitOpts {
  /** Only tags log lines. */
  label: string;
}

const BROADCAST_CHANNEL_NAME = 'dotli:scheduled-notifications';
type WakeMessage = { kind: 'scheduled' } | { kind: 'cancelled' } | { kind: 'fired'; hostId: number };

let initialized = false;
let shuttingDown = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let bcChannel: BroadcastChannel | null = null;
const inFlight = new Set<number>();
// The poller retries every second, so a failure is reported when it starts, not on every tick.
type PollStep = 'remove_stale' | 'list_pending' | 'claim';
const failing = new Set<PollStep>();

function succeeded(step: PollStep): void {
  failing.delete(step);
}

function failed(step: PollStep, err: unknown): void {
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
}

export function initScheduledNotifications(opts: InitOpts): void {
  if (initialized) {
    return;
  }
  initialized = true;

  if (typeof BroadcastChannel === 'function') {
    bcChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    bcChannel.onmessage = () => {
      ensurePolling();
    };
  }

  log.debug(`[${opts.label}] scheduled notifications: init`);

  void rehydrate().then(() => {
    ensurePolling();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      ensurePolling();
    }
  });

  // IDB starts closing as unload begins, so a later tick throws `InvalidStateError`. `pagehide`, not
  // `beforeunload`, because it also fires on the bfcache path.
  window.addEventListener('pagehide', () => {
    shuttingDown = true;
    stopPolling();
    bcChannel?.close();
    bcChannel = null;
  });
}

/** An immediate fire (null or past `scheduledAt`) only allocates an id and is not persisted. */
export async function scheduleNotification(req: {
  productId: string;
  title: string;
  text: string;
  deeplink: string | null;
  scheduledAt: number | null;
}): Promise<ScheduleNotificationResult> {
  const now = Date.now();

  if (req.scheduledAt === null || req.scheduledAt <= now) {
    const id = await allocateId(req.productId);
    return { ok: true, id, immediate: true };
  }

  const result = await dbSchedule({
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
}

/** Idempotent. False when the record had already fired or never existed. */
export async function cancelNotification(productId: string, perProductId: number): Promise<boolean> {
  const removed = await dbCancel(productId, perProductId);
  if (removed) {
    bcChannel?.postMessage({ kind: 'cancelled' } satisfies WakeMessage);
  }
  return removed;
}

async function rehydrate(): Promise<void> {
  const records = await pendingRecords();
  const now = Date.now();
  for (const rec of records ?? []) {
    if (rec.scheduledAt > now) {
      continue;
    }
    await tryFire(rec, 'rehydrate');
  }
}

/** Null when listing failed. */
async function pendingRecords(): Promise<ScheduledNotificationRecord[] | null> {
  try {
    await removeStale(Date.now());
    succeeded('remove_stale');
  } catch (err) {
    failed('remove_stale', err);
  }

  let records: ScheduledNotificationRecord[];
  try {
    records = await listAll();
    succeeded('list_pending');
  } catch (err) {
    failed('list_pending', err);
    return null;
  }
  return records;
}

function ensurePolling(): void {
  if (shuttingDown || pollTimer !== null) {
    return;
  }
  pollTimer = setInterval(() => {
    void tick();
  }, SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollTimer === null) {
    return;
  }
  clearInterval(pollTimer);
  pollTimer = null;
}

async function tick(): Promise<void> {
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

  const isVisible = document.visibilityState === 'visible';
  const offset = isVisible ? 0 : SCHEDULED_NOTIFICATIONS_HIDDEN_TAB_OFFSET_MS;
  const cutoff = Date.now() - offset;

  for (const rec of records) {
    if (rec.scheduledAt > cutoff) {
      continue;
    }
    await tryFire(rec, 'realtime');
  }
}

async function tryFire(rec: ScheduledNotificationRecord, source: 'realtime' | 'rehydrate'): Promise<void> {
  if (inFlight.has(rec.hostId)) {
    return;
  }
  inFlight.add(rec.hostId);
  try {
    const claimAndFire = async (): Promise<void> => {
      const binding = await findNotification(rec.productId, rec.perProductId);
      if (!binding || binding.expiresAt <= Date.now() || !notificationDeliveryIsCurrent(binding.scope)) {
        return;
      }
      const removed = await removeById(rec.hostId);
      if (!removed) {
        return;
      }
      await fire(rec, source);
      bcChannel?.postMessage({
        kind: 'fired',
        hostId: rec.hostId,
      } satisfies WakeMessage);
    };

    if ('locks' in navigator) {
      await navigator.locks.request(`dotli-notif:${String(rec.hostId)}`, { ifAvailable: true }, async lock => {
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
  } finally {
    inFlight.delete(rec.hostId);
  }
}

async function fire(rec: ScheduledNotificationRecord, source: 'realtime' | 'rehydrate'): Promise<void> {
  await presentProductNotification({
    label: rec.title,
    product: rec.productId,
    id: rec.perProductId,
    text: rec.text,
    // Past-due delivery stays in-page rather than surprising users with an OS toast.
    browserNotification: source === 'realtime',
  });
}
