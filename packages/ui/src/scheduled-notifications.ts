// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Scheduled notifications runtime: a polling loop plus cross-tab
 * coordination on top of the IDB-backed queue in
 * @dotli/storage/scheduled-notifications.
 *
 * Runs in the product origin's top frame (for example acme.dot.li).
 * A guest dapp schedules via host-api 0.7, the record lands in IDB, and
 * any tab on this origin fires it once it is past due.
 *
 * Two mechanisms keep sibling same-origin tabs from firing the same
 * record twice. A Web Lock named `dotli-notif:<hostId>` lets one tab do
 * the work at a time. The atomic IDB delete inside that lock is what
 * actually claims the record. The lock only avoids redundant work.
 * Separately, a BroadcastChannel `dotli:scheduled-notifications` wakes
 * the polling loop in sibling tabs on every schedule or cancel, so a
 * freshly scheduled record does not wait a full tick to be noticed.
 *
 * A hidden tab queries past-due records at `now - HIDDEN_TAB_OFFSET_MS`,
 * giving a visible sibling a 300ms head start on the lock. If every
 * sibling tab is hidden, the hidden tab fires 300ms late. That stays
 * well within the few-second error margin allowed for scheduled web
 * notifications.
 */

import {
  schedule as dbSchedule,
  cancel as dbCancel,
  allocateId,
  listAll,
  removeById,
  removeStale,
  type ScheduledNotificationRecord,
} from "@dotli/storage/scheduled-notifications";
import {
  SCHEDULED_NOTIFICATIONS_HIDDEN_TAB_OFFSET_MS,
  SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS,
} from "@dotli/config/config";
import { log } from "@dotli/shared/log";
import { showNotification } from "./notification";

export type ScheduleNotificationResult =
  | { ok: true; id: number; immediate: boolean }
  | { ok: false; error: "ScheduleLimitReached" };

interface InitOpts {
  // The top-frame product label. Used only as a tag in log lines. Record
  // titles in IDB are what the UI actually renders.
  label: string;
}

const BROADCAST_CHANNEL_NAME = "dotli:scheduled-notifications";
type WakeMessage =
  | { kind: "scheduled" }
  | { kind: "cancelled" }
  | { kind: "fired"; hostId: number };

let initialized = false;
let shuttingDown = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let bcChannel: BroadcastChannel | null = null;
// Hosts currently being fired by this tab. Within a single tab the IDB
// `removeById` is the source of truth for "claimed". Tracking in-flight
// fires here lets us skip records we have already begun processing this
// tick.
const inFlight = new Set<number>();

export function initScheduledNotifications(opts: InitOpts): void {
  if (initialized) {
    return;
  }
  initialized = true;

  if (typeof BroadcastChannel === "function") {
    bcChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    bcChannel.onmessage = () => {
      ensurePolling();
    };
  }

  log.warn(`[${opts.label}] scheduled notifications: init`);

  void rehydrate().then(() => {
    ensurePolling();
  });

  // Restart polling when the tab becomes visible. Gives a stale visible
  // tab a chance to drain the queue before the next tick.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      ensurePolling();
    }
  });

  // Stop the polling loop before the page is torn down. The IDB
  // connection enters "closing" the moment unload begins, and any tick
  // still in flight at that point throws `InvalidStateError` from
  // `db.transaction()`. `pagehide` fires for both regular unloads and
  // the bfcache path, which is why it is preferred over `beforeunload`.
  window.addEventListener("pagehide", () => {
    shuttingDown = true;
    stopPolling();
    bcChannel?.close();
    bcChannel = null;
  });
}

/**
 * Schedule a notification, called by the host-api `handlePushNotification`
 * handler.
 *
 * An immediate fire (null or past `scheduledAt`) only bumps the counter to
 * allocate an id. Everything else is persisted to IDB.
 */
export async function scheduleNotification(req: {
  productId: string;
  title: string;
  text: string;
  deeplink: string | null;
  scheduledAt: number | null;
}): Promise<ScheduleNotificationResult> {
  const now = Date.now();

  // Inline the null/past check so `scheduledAt` narrows to `number` below
  // without a non-null assertion.
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
  bcChannel?.postMessage({ kind: "scheduled" } satisfies WakeMessage);

  return { ok: true, id: result.id, immediate: false };
}

/**
 * Cancel a pending notification, called by the host-api
 * `handlePushNotificationCancel` handler.
 *
 * Idempotent. Returns true if a pending record was removed, false if it
 * had already fired or never existed.
 */
export async function cancelNotification(
  productId: string,
  perProductId: number,
): Promise<boolean> {
  const removed = await dbCancel(productId, perProductId);
  if (removed) {
    bcChannel?.postMessage({ kind: "cancelled" } satisfies WakeMessage);
  }
  return removed;
}

async function rehydrate(): Promise<void> {
  try {
    await removeStale(Date.now());
  } catch (err) {
    log.error(
      "[scheduled notifications] removeStale on rehydrate failed:",
      err,
    );
  }

  let records: ScheduledNotificationRecord[];
  try {
    records = await listAll();
  } catch (err) {
    log.error("[scheduled notifications] listAll on rehydrate failed:", err);
    return;
  }

  const now = Date.now();
  for (const rec of records) {
    if (rec.scheduledAt > now) {
      continue;
    }
    await tryFire(rec, "rehydrate");
  }
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
  try {
    await removeStale(Date.now());
  } catch (err) {
    log.error("[scheduled notifications] removeStale failed:", err);
  }

  let records: ScheduledNotificationRecord[];
  try {
    records = await listAll();
  } catch (err) {
    log.error("[scheduled notifications] listAll failed:", err);
    return;
  }

  if (records.length === 0) {
    stopPolling();
    return;
  }

  const isVisible = document.visibilityState === "visible";
  const offset = isVisible ? 0 : SCHEDULED_NOTIFICATIONS_HIDDEN_TAB_OFFSET_MS;
  const cutoff = Date.now() - offset;

  for (const rec of records) {
    if (rec.scheduledAt > cutoff) {
      continue;
    }
    await tryFire(rec, "realtime");
  }
}

async function tryFire(
  rec: ScheduledNotificationRecord,
  source: "realtime" | "rehydrate",
): Promise<void> {
  if (inFlight.has(rec.hostId)) {
    return;
  }
  inFlight.add(rec.hostId);
  try {
    const claimAndFire = async (): Promise<void> => {
      const removed = await removeById(rec.hostId);
      if (!removed) {
        // Sibling tab won the race.
        return;
      }
      fire(rec, source);
      bcChannel?.postMessage({
        kind: "fired",
        hostId: rec.hostId,
      } satisfies WakeMessage);
    };

    if ("locks" in navigator) {
      await navigator.locks.request(
        `dotli-notif:${String(rec.hostId)}`,
        { ifAvailable: true },
        async (lock) => {
          // Another tab holds the lock, so let it fire.
          if (!lock) {
            return;
          }
          await claimAndFire();
        },
      );
    } else {
      // No Web Locks. Rely on IDB tx serialization in `removeById`.
      await claimAndFire();
    }
  } finally {
    inFlight.delete(rec.hostId);
  }
}

function fire(
  rec: ScheduledNotificationRecord,
  source: "realtime" | "rehydrate",
): void {
  showNotification({
    label: rec.title,
    text: rec.text,
    deeplink: rec.deeplink ?? undefined,
    // Past-due fires (rehydrate) render the in-app banner only. An OS
    // toast for an event the user was not around for is intrusive.
    browserNotification: source === "realtime",
  });
}
