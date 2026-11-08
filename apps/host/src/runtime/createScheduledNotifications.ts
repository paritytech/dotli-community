// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Any tab on the product origin fires a past-due record. The atomic IDB delete claims it, while the
// Web Lock only avoids redundant work. A hidden tab lags by an offset so a visible sibling wins the lock.

import type { ProductId } from '@parity/truapi';
import { scheduledNotifications, isExpectedDbError, type ScheduledNotificationRecord } from '@dotli/storage';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  log,
  listen,
  listenForDocumentVisible,
  realTimers,
  type Timers,
  type VisibilitySource,
} from '@dotli/shared';
import type { ShowNotification } from '@dotli/ui';
import { pagePoll, type Poll } from '../pagePoll.js';

const report = createReporter({ flow: 'notifications' });

/**
 * Count. A step of the scheduled notifications poll failed, once per failing run of the step. Tagged `outcome`
 * (error), `reason` (the error's name) and `step` (`remove_stale, list_pending, claim`). An IndexedDB failure the
 * browser causes is expected, the rest captured.
 */
const notificationsPollMetric = defineCount<'error'>('notifications.poll');

export type ScheduleNotificationResult =
  { ok: true; id: number; immediate: boolean } | { ok: false; error: 'ScheduleLimitReached' };

type InitParams = {
  /** Only tags log lines. */
  label: string;
};

type ScheduleRequest = {
  productId: ProductId;
  title: string;
  text: string;
  deeplink: string | null;
  scheduledAt: number | null;
};

export type ScheduledNotificationStore = typeof scheduledNotifications;

export type ScheduledNotificationsParams = {
  /** Where scheduled notifications persist. */
  store: ScheduledNotificationStore;
  /** Shows a notification that fell due. */
  show: ShowNotification;
  /** Undefined where the browser has no Web Locks. */
  locks: Pick<LockManager, 'request'> | undefined;
  /** Null where the browser has no BroadcastChannel. */
  openChannel: (name: string) => BroadcastChannel | null;
  /** The document, whose visibility sets how late a due notification may show. */
  visibility: VisibilitySource;
  /** The window, whose `pagehide` stops the poller and whose restoring `pageshow` starts it again. */
  lifecycle: EventTarget;
  /** The clock that tells which notifications fell due. The page's own by default. */
  timers?: Pick<Timers, 'now'>;
  /** The poller's repeating tick. The page's interval by default. */
  poll?: Poll;
};

/** What the page's scheduler takes beside the page's own database, locks, channels and document. */
type CreatePageScheduledNotificationsParams = Pick<ScheduledNotificationsParams, 'show'>;

export type ScheduledNotifications = ReturnType<typeof createScheduledNotifications>;

type WakeMessage = { kind: 'scheduled' } | { kind: 'cancelled' } | { kind: 'fired'; hostId: number };

// The poller retries every second, so a failure is reported when it starts, not on every tick.
type PollStep = 'remove_stale' | 'list_pending' | 'claim';

export const SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS = 1_000;

/** Hidden tabs fire only records older than `now - offset`, giving a visible tab first crack at the lock. */
const SCHEDULED_NOTIFICATIONS_HIDDEN_TAB_OFFSET_MS = 300;

const BROADCAST_CHANNEL_NAME = 'dotli:scheduled-notifications';

/** Builds the scheduler over `store`, showing each due notification through `show`. Building it never throws. */
export function createScheduledNotifications({
  store,
  show,
  locks,
  openChannel,
  visibility,
  lifecycle,
  timers = realTimers,
  poll = pagePoll,
}: ScheduledNotificationsParams) {
  let initialized = false;
  let shuttingDown = false;
  // Aborts on dispose, after which the scheduler starts no poller, opens no channel and claims no record.
  const lifetime = new AbortController();
  let stopPoll: (() => void) | null = null;
  let stopListening: (() => void) | null = null;
  let broadcastChannel: BroadcastChannel | null = null;
  const failing = new Set<PollStep>();
  // One claim per record at a time. A claim that queued behind another finds the record gone and fires nothing.
  const claims = createAsyncTaskPool({ poolSize: 1 });

  function markSucceeded(step: PollStep): void {
    failing.delete(step);
  }

  function reportFailure(step: PollStep, error: unknown): void {
    // The connection closes as the page unloads, so a tick caught by it is moot.
    if (shuttingDown || failing.has(step)) {
      return;
    }
    failing.add(step);
    if (isExpectedDbError(error)) {
      report.expected(error, { step, metric: notificationsPollMetric, attributes: { step } });
      return;
    }
    report.defect(error, {
      step,
      metric: notificationsPollMetric,
      message: `[scheduled notifications] ${step} failed:`,
      attributes: { step },
    });
  }

  /** Null when listing failed. */
  async function listPendingRecords(): Promise<ScheduledNotificationRecord[] | null> {
    try {
      await store.removeStale(timers.now());
      markSucceeded('remove_stale');
    } catch (error) {
      reportFailure('remove_stale', error);
    }

    try {
      const records = await store.listAll();
      markSucceeded('list_pending');
      return records;
    } catch (error) {
      reportFailure('list_pending', error);
      return null;
    }
  }

  function fire(record: ScheduledNotificationRecord, source: 'realtime' | 'rehydrate'): void {
    show({
      label: record.title,
      text: record.text,
      deeplink: record.deeplink ?? undefined,
      // An OS toast for an event the user was not around for is intrusive.
      browserNotification: source === 'realtime',
    });
  }

  async function claim(record: ScheduledNotificationRecord, source: 'realtime' | 'rehydrate'): Promise<void> {
    async function claimAndFire(): Promise<void> {
      // A disposed scheduler leaves the record in the store for another tab or the next load to fire.
      if (lifetime.signal.aborted) {
        return;
      }
      const removed = await store.removeById(record.hostId);
      if (!removed) {
        return;
      }
      fire(record, source);
      broadcastChannel?.postMessage({
        kind: 'fired',
        hostId: record.hostId,
      } satisfies WakeMessage);
    }

    try {
      if (locks !== undefined) {
        await locks.request(`dotli-notif:${String(record.hostId)}`, { ifAvailable: true }, async lock => {
          if (!lock) {
            return;
          }
          await claimAndFire();
        });
      } else {
        // The IDB delete still claims the record alone.
        await claimAndFire();
      }
      markSucceeded('claim');
    } catch (error) {
      reportFailure('claim', error);
    }
  }

  function tryFire(record: ScheduledNotificationRecord, source: 'realtime' | 'rehydrate'): Promise<void> {
    return claims.call(() => claim(record, source), { pool: String(record.hostId) });
  }

  function stopPolling(): void {
    if (stopPoll === null) {
      return;
    }
    stopPoll();
    stopPoll = null;
  }

  async function tick(): Promise<void> {
    if (shuttingDown) {
      return;
    }
    const records = await listPendingRecords();
    if (records === null) {
      return;
    }

    if (records.length === 0) {
      stopPolling();
      return;
    }

    const isVisible = visibility.visibilityState === 'visible';
    const offset = isVisible ? 0 : SCHEDULED_NOTIFICATIONS_HIDDEN_TAB_OFFSET_MS;
    const cutoff = timers.now() - offset;

    for (const record of records) {
      if (record.scheduledAt > cutoff) {
        continue;
      }
      await tryFire(record, 'realtime');
    }
  }

  function ensurePolling(): void {
    if (shuttingDown || lifetime.signal.aborted || stopPoll !== null) {
      return;
    }
    stopPoll = poll.start(() => {
      void tick();
    }, SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS);
  }

  function openBroadcast(): void {
    // A restore without a preceding `pagehide` keeps its channel, so none is opened twice.
    if (broadcastChannel !== null) {
      return;
    }
    broadcastChannel = openChannel(BROADCAST_CHANNEL_NAME);
    if (broadcastChannel !== null) {
      broadcastChannel.onmessage = () => {
        ensurePolling();
      };
    }
  }

  function closeBroadcast(): void {
    broadcastChannel?.close();
    broadcastChannel = null;
  }

  async function rehydrate(): Promise<void> {
    const records = await listPendingRecords();
    const now = timers.now();
    for (const record of records ?? []) {
      if (record.scheduledAt > now) {
        continue;
      }
      await tryFire(record, 'rehydrate');
    }
  }

  function init({ label }: InitParams): void {
    if (initialized || lifetime.signal.aborted) {
      return;
    }
    initialized = true;

    openBroadcast();

    log.debug(`[${label}] scheduled notifications: init`);

    void rehydrate().then(() => {
      ensurePolling();
    });

    stopListening = listenForPage();
  }

  /** Follows the page as it shows, hides and comes back from the back-forward cache, until the returned stop. */
  function listenForPage(): () => void {
    const stopVisible = listenForDocumentVisible(visibility, ensurePolling);

    // IDB starts closing as unload begins, so a later tick throws `InvalidStateError`. `pagehide`, not
    // `beforeunload`, because it also fires on the bfcache path.
    const stopHide = listen({
      target: lifecycle,
      type: 'pagehide',
      handler: () => {
        shuttingDown = true;
        stopPolling();
        closeBroadcast();
      },
    });

    // A page restored from the back-forward cache runs on where `pagehide` stopped it, so the channel and the
    // poller come back, and a record that fell due meanwhile fires. The first load's `pageshow` is not a restore.
    const stopShow = listen({
      target: lifecycle,
      type: 'pageshow',
      handler: event => {
        if (!('persisted' in event) || event.persisted !== true) {
          return;
        }
        shuttingDown = false;
        openBroadcast();
        void rehydrate().then(() => {
          ensurePolling();
        });
      },
    });

    return stop;

    function stop(): void {
      stopVisible();
      stopHide();
      stopShow();
    }
  }

  async function schedule(request: ScheduleRequest): Promise<ScheduleNotificationResult> {
    const now = timers.now();

    if (request.scheduledAt === null || request.scheduledAt <= now) {
      const id = await store.allocateId(request.productId);
      return { ok: true, id, immediate: true };
    }

    const result = await store.schedule({
      productId: request.productId,
      title: request.title,
      text: request.text,
      deeplink: request.deeplink,
      scheduledAt: request.scheduledAt,
    });

    if (!result.ok) {
      return result;
    }

    ensurePolling();
    broadcastChannel?.postMessage({ kind: 'scheduled' } satisfies WakeMessage);

    return { ok: true, id: result.id, immediate: false };
  }

  async function cancel(productId: ProductId, perProductId: number): Promise<boolean> {
    const removed = await store.cancel(productId, perProductId);
    if (removed) {
      broadcastChannel?.postMessage({ kind: 'cancelled' } satisfies WakeMessage);
    }
    return removed;
  }

  function dispose(): void {
    lifetime.abort(new Error('The notification scheduler was disposed'));
    stopListening?.();
    stopListening = null;
    stopPolling();
    closeBroadcast();
  }

  return {
    /**
     * Opens the channel, fires what fell due and starts the poller. Idempotent, never throws, and does nothing after
     * `dispose`.
     */
    init,
    /**
     * Schedules a notification. An immediate fire (null or past `scheduledAt`) only allocates an id and is not
     * persisted. After `dispose` it still persists the notification for another tab or the next load to fire, but
     * starts no poller. Rejects when the store cannot allocate or write it.
     */
    schedule,
    /**
     * Idempotent, also after `dispose`. False when the record had already fired or never existed. Rejects when the
     * store cannot remove it.
     */
    cancel,
    /**
     * Stops the poller, closes the channel and stops hearing the page, so a round in flight claims nothing more, an
     * `init` or a restore after it starts nothing, a `schedule` or `cancel` still settles as the store answers, and it
     * is safe to call twice or after a failed round and never throws.
     */
    dispose,
  };
}

/**
 * Builds the page's scheduler, over the dotli database, the browser's locks and channels, and this document. Never
 * throws.
 */
export function createPageScheduledNotifications({
  show,
}: CreatePageScheduledNotificationsParams): ScheduledNotifications {
  return createScheduledNotifications({
    store: scheduledNotifications,
    show,
    locks: 'locks' in navigator ? navigator.locks : undefined,
    openChannel: name => (typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null),
    visibility: document,
    lifecycle: window,
  });
}
