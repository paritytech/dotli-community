// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Any tab on the product origin fires a past-due record. The atomic IDB delete claims it, while the
// Web Lock only avoids redundant work. A hidden tab lags by an offset so a visible sibling wins the lock.

import type { ProductId } from '@parity/truapi';
import { scheduledNotifications, isExpectedDbError, type ScheduledNotificationRecord } from '@dotli/storage';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createStateMachine,
  log,
  listen,
  listenForDocumentVisible,
  realTimers,
  type HandlerOf,
  type MachineTypes,
  type Timers,
  type Transition,
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

/** Count. A transition of the scheduler threw. Tagged `outcome` (error) and `reason` (the error's name). */
const notificationsTransitionMetric = defineCount<'error'>('notifications.transition');

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

type PollStep = 'remove_stale' | 'list_pending' | 'claim';

type FireSource = 'realtime' | 'rehydrate';

/** A round's step. A step's events carry the `Round` value they were started for. */
type Round =
  | { kind: 'removingStale' }
  | { kind: 'listing' }
  // Claims the first of `due`.
  | { kind: 'claiming'; due: readonly [ScheduledNotificationRecord, ...ScheduledNotificationRecord[]] };

type ClaimingRound = Extract<Round, { kind: 'claiming' }>;

type Running = {
  stopListening: () => void;
  channel: BroadcastChannel | null;
  /** Aborts when the scheduler is disposed, so a claim in flight starts no delete. */
  lifetime: AbortController;
};

/** `rehydrating` fires what fell due as `rehydrate`, and `ticking` as `realtime`. */
type SchedulerState =
  | { kind: 'uninitialized' }
  | ({ kind: 'idle' } & Running)
  | ({ kind: 'polling'; stopPoll: () => void } & Running)
  | ({ kind: 'rehydrating'; round: Round } & Running)
  // `rescan` is set when a notification was scheduled meanwhile, so the round's list may predate it and an empty list
  // does not stop the poller.
  | ({ kind: 'ticking'; stopPoll: () => void; round: Round; rescan: boolean } & Running)
  | { kind: 'hidden'; stopListening: () => void; lifetime: AbortController }
  | { kind: 'disposed' };

/** The kinds that run a round. */
type RoundState = Extract<SchedulerState, { kind: 'rehydrating' | 'ticking' }>;

/** The kinds of a shown page, which hold the channel. */
type AwakeKind = 'idle' | 'polling' | 'rehydrating' | 'ticking';

type SchedulerEvent =
  | { kind: 'initialized'; label: string }
  | { kind: 'ticked' }
  | { kind: 'woken' }
  | { kind: 'scheduled' }
  | { kind: 'cancelled' }
  | { kind: 'pageHidden' }
  | { kind: 'pageRestored' }
  | { kind: 'disposed' }
  | { kind: 'staleRemoved'; round: Round }
  | { kind: 'staleRemoveFailed'; round: Round; error: unknown }
  | { kind: 'listed'; round: Round; records: readonly ScheduledNotificationRecord[] }
  | { kind: 'listFailed'; round: Round; error: unknown }
  | { kind: 'claimed'; round: ClaimingRound; record: ScheduledNotificationRecord; removed: boolean; source: FireSource }
  | { kind: 'claimFailed'; round: ClaimingRound; error: unknown };

type SchedulerEffect =
  | { kind: 'initialized'; label: string }
  | { kind: 'stepSucceeded'; step: PollStep }
  | { kind: 'stepFailed'; step: PollStep; error: unknown }
  | { kind: 'fired'; record: ScheduledNotificationRecord; source: FireSource };

type SchedulerMachine = MachineTypes<SchedulerState, SchedulerEvent, SchedulerEffect>;

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
  /** Moves the round on to listing once the stale records are gone. */
  const listAfterStale: HandlerOf<SchedulerMachine, 'rehydrating' | 'ticking', 'staleRemoved'> = (
    state,
    { round },
    transition,
  ) => {
    if (round !== state.round) {
      return;
    }
    transition.emitSideEffect({ kind: 'stepSucceeded', step: 'remove_stale' });
    runStep({ ...state, round: { kind: 'listing' } }, transition);
  };
  /** Moves the round on to listing, since a stale record left behind is only a record not yet due. */
  const listAfterStaleFailed: HandlerOf<SchedulerMachine, 'rehydrating' | 'ticking', 'staleRemoveFailed'> = (
    state,
    { round, error },
    transition,
  ) => {
    if (round !== state.round) {
      return;
    }
    transition.emitSideEffect({ kind: 'stepFailed', step: 'remove_stale', error });
    runStep({ ...state, round: { kind: 'listing' } }, transition);
  };
  /** Claims the listed records that fell due. A tick that lists none stops the poller. */
  const claimListed: HandlerOf<SchedulerMachine, 'rehydrating' | 'ticking', 'listed'> = (
    state,
    { round, records },
    transition,
  ) => {
    if (round !== state.round) {
      return;
    }
    transition.emitSideEffect({ kind: 'stepSucceeded', step: 'list_pending' });
    switch (state.kind) {
      case 'rehydrating': {
        const now = timers.now();
        claimNext(
          state,
          records.filter(r => r.scheduledAt <= now),
          transition,
        );
        return;
      }
      case 'ticking': {
        if (records.length === 0 && !state.rescan) {
          transition.emitState({ kind: 'idle', ...pickRunning(state) });
          state.stopPoll();
          return;
        }
        const offset = visibility.visibilityState === 'visible' ? 0 : SCHEDULED_NOTIFICATIONS_HIDDEN_TAB_OFFSET_MS;
        const cutoff = timers.now() - offset;
        claimNext(
          state,
          records.filter(r => r.scheduledAt <= cutoff),
          transition,
        );
        return;
      }
    }
  };
  const endFailedList: HandlerOf<SchedulerMachine, 'rehydrating' | 'ticking', 'listFailed'> = (
    state,
    { round, error },
    transition,
  ) => {
    if (round !== state.round) {
      return;
    }
    transition.emitSideEffect({ kind: 'stepFailed', step: 'list_pending', error });
    endRound(state, transition);
  };
  /** Shows a record this tab removed, whatever round claimed it, since the delete is what claims it. */
  const fireClaimed: HandlerOf<SchedulerMachine, AwakeKind | 'hidden', 'claimed'> = (
    state,
    { record, removed, source },
    { emitSideEffect },
  ) => {
    if (!removed) {
      return;
    }
    emitSideEffect({ kind: 'fired', record, source });
    switch (state.kind) {
      case 'idle':
      case 'polling':
      case 'rehydrating':
      case 'ticking':
        state.channel?.postMessage({ kind: 'fired', hostId: record.hostId } satisfies WakeMessage);
        return;
      // Its channel closed as the page hid.
      case 'hidden':
        return;
    }
  };
  /** Claims the next due record when the claim is this round's, then shows the claimed one. */
  const settleClaim: HandlerOf<SchedulerMachine, 'rehydrating' | 'ticking', 'claimed'> = (state, event, transition) => {
    if (event.round === state.round) {
      const [, ...rest] = event.round.due;
      transition.emitSideEffect({ kind: 'stepSucceeded', step: 'claim' });
      claimNext(state, rest, transition);
    }
    fireClaimed(state, event, transition);
  };
  /** Claims the next due record, leaving the one whose claim failed for a later round. */
  const skipFailedClaim: HandlerOf<SchedulerMachine, 'rehydrating' | 'ticking', 'claimFailed'> = (
    state,
    { round, error },
    transition,
  ) => {
    if (round !== state.round) {
      return;
    }
    const [, ...rest] = round.due;
    transition.emitSideEffect({ kind: 'stepFailed', step: 'claim', error });
    claimNext(state, rest, transition);
  };
  const announceScheduled: HandlerOf<SchedulerMachine, 'polling' | 'rehydrating' | 'ticking', 'scheduled'> = ({
    channel,
  }) => {
    channel?.postMessage({ kind: 'scheduled' } satisfies WakeMessage);
  };
  const announceCancelled: HandlerOf<SchedulerMachine, AwakeKind, 'cancelled'> = ({ channel }) => {
    channel?.postMessage({ kind: 'cancelled' } satisfies WakeMessage);
  };
  /** Stops the poller and closes the channel, since IDB starts closing as the page unloads. */
  const hide: HandlerOf<SchedulerMachine, AwakeKind, 'pageHidden'> = (state, _event, { emitState }) => {
    const { stopListening, lifetime } = state;
    emitState({ kind: 'hidden', stopListening, lifetime });
    stopWaking(state);
  };
  const shutDown: HandlerOf<SchedulerMachine, AwakeKind | 'hidden', 'disposed'> = (state, _event, { emitState }) => {
    emitState({ kind: 'disposed' });
    state.lifetime.abort(new Error('The notification scheduler was disposed'));
    state.stopListening();
    switch (state.kind) {
      case 'idle':
      case 'polling':
      case 'rehydrating':
      case 'ticking':
        stopWaking(state);
        return;
      // Its poller and channel stopped as the page hid.
      case 'hidden':
        return;
    }
  };
  // The poller retries every second, so a step's failure is reported when it starts failing, not on every tick.
  const failingSteps = new Set<PollStep>();
  const machine = createStateMachine<SchedulerMachine>({
    initial: { kind: 'uninitialized' },
    handlers: {
      uninitialized: {
        initialized(_state, { label }, transition) {
          const stopListening = listenForPage(transition.update);
          const channel = openWakeChannel(transition.update);
          transition.emitSideEffect({ kind: 'initialized', label });
          runStep(
            {
              kind: 'rehydrating',
              round: { kind: 'removingStale' },
              stopListening,
              channel,
              lifetime: new AbortController(),
            },
            transition,
          );
        },
        disposed(_state, _event, { emitState }) {
          emitState({ kind: 'disposed' });
        },
      },
      idle: {
        woken(state, _event, transition) {
          startPolling(state, transition);
        },
        scheduled(state, _event, transition) {
          startPolling(state, transition);
          state.channel?.postMessage({ kind: 'scheduled' } satisfies WakeMessage);
        },
        cancelled: announceCancelled,
        claimed: fireClaimed,
        pageHidden: hide,
        disposed: shutDown,
      },
      polling: {
        ticked(state, _event, transition) {
          runStep({ ...state, kind: 'ticking', round: { kind: 'removingStale' }, rescan: false }, transition);
        },
        scheduled: announceScheduled,
        cancelled: announceCancelled,
        claimed: fireClaimed,
        pageHidden: hide,
        disposed: shutDown,
      },
      rehydrating: {
        staleRemoved: listAfterStale,
        staleRemoveFailed: listAfterStaleFailed,
        listed: claimListed,
        listFailed: endFailedList,
        claimed: settleClaim,
        claimFailed: skipFailedClaim,
        scheduled: announceScheduled,
        cancelled: announceCancelled,
        pageHidden: hide,
        disposed: shutDown,
      },
      // A tick while the round runs is ignored, so rounds never overlap.
      ticking: {
        staleRemoved: listAfterStale,
        staleRemoveFailed: listAfterStaleFailed,
        listed: claimListed,
        listFailed: endFailedList,
        claimed: settleClaim,
        claimFailed: skipFailedClaim,
        scheduled(state, _event, { emitState }) {
          emitState({ ...state, rescan: true });
          state.channel?.postMessage({ kind: 'scheduled' } satisfies WakeMessage);
        },
        cancelled: announceCancelled,
        pageHidden: hide,
        disposed: shutDown,
      },
      // A round the page hid in reports nothing, since its connection closes as the page unloads.
      hidden: {
        claimed: fireClaimed,
        pageRestored(state, _event, transition) {
          const channel = openWakeChannel(transition.update);
          runStep({ ...state, kind: 'rehydrating', round: { kind: 'removingStale' }, channel }, transition);
        },
        disposed: shutDown,
      },
      disposed: null,
    },
    onEffect(effect) {
      switch (effect.kind) {
        case 'initialized':
          log.debug(`[${effect.label}] scheduled notifications: init`);
          return;
        case 'stepSucceeded':
          failingSteps.delete(effect.step);
          return;
        case 'stepFailed': {
          const { step, error } = effect;
          if (failingSteps.has(step)) {
            return;
          }
          failingSteps.add(step);
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
          return;
        }
        case 'fired': {
          const { record, source } = effect;
          show({
            label: record.title,
            text: record.text,
            deeplink: record.deeplink ?? undefined,
            // An OS toast for an event the user was not around for is intrusive.
            browserNotification: source === 'realtime',
          });
          return;
        }
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: notificationsTransitionMetric,
        message: '[scheduled notifications] A transition of the scheduler threw:',
      });
    },
  });

  return {
    /**
     * Opens the channel, fires what fell due and starts the poller. Idempotent, never throws, and does nothing after
     * `dispose`.
     */
    init,
    /**
     * Schedules a notification. An immediate fire (null or past `scheduledAt`) only allocates an id and is not
     * persisted. Before `init` it starts no poller, and `init` fires it once due. After `dispose` it still persists the
     * notification for another tab or the next load to fire, but starts no poller. Rejects when the store cannot
     * allocate or write it.
     */
    schedule,
    /**
     * Idempotent, also after `dispose`. False when the record had already fired or never existed. Rejects when the
     * store cannot remove it.
     */
    cancel,
    /**
     * Stops the poller, closes the channel and stops hearing the page, so a round in flight claims nothing more and a
     * claim whose delete is running shows nothing, an `init` or a restore after it starts nothing, a `schedule` or
     * `cancel` still settles as the store answers, and it is safe to call twice or after a failed round and never
     * throws.
     */
    dispose,
  };

  function init({ label }: InitParams): void {
    machine.update({ kind: 'initialized', label });
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

    machine.update({ kind: 'scheduled' });

    return { ok: true, id: result.id, immediate: false };
  }

  async function cancel(productId: ProductId, perProductId: number): Promise<boolean> {
    const removed = await store.cancel(productId, perProductId);
    if (removed) {
      machine.update({ kind: 'cancelled' });
    }
    return removed;
  }

  function dispose(): void {
    machine.update({ kind: 'disposed' });
  }

  /** Moves to `state`, then starts the work of its round's step. */
  function runStep(state: RoundState, { emitState, update }: Transition<SchedulerMachine>): void {
    emitState(state);
    const { round } = state;
    switch (round.kind) {
      case 'removingStale':
        update(
          store.removeStale(timers.now()).then(
            () => ({ kind: 'staleRemoved', round }),
            (error: unknown) => ({ kind: 'staleRemoveFailed', round, error }),
          ),
        );
        return;
      case 'listing':
        update(
          store.listAll().then(
            records => ({ kind: 'listed', round, records }),
            (error: unknown) => ({ kind: 'listFailed', round, error }),
          ),
        );
        return;
      case 'claiming': {
        const [record] = round.due;
        const source = getFireSource(state);
        update(
          claim(record, state.lifetime.signal).then(
            removed => ({ kind: 'claimed', round, record, removed, source }),
            (error: unknown) => ({ kind: 'claimFailed', round, error }),
          ),
        );
        return;
      }
    }
  }

  /** Claims the first of `due`, or ends the round when none is left. */
  function claimNext(
    state: RoundState,
    due: readonly ScheduledNotificationRecord[],
    transition: Transition<SchedulerMachine>,
  ): void {
    const [record, ...rest] = due;
    if (record === undefined) {
      endRound(state, transition);
      return;
    }
    runStep({ ...state, round: { kind: 'claiming', due: [record, ...rest] } }, transition);
  }

  /** Ends the round in `polling`, with the poller kept or started. */
  function endRound(state: RoundState, transition: Transition<SchedulerMachine>): void {
    switch (state.kind) {
      case 'rehydrating':
        startPolling(state, transition);
        return;
      case 'ticking':
        transition.emitState({ kind: 'polling', stopPoll: state.stopPoll, ...pickRunning(state) });
        return;
    }
  }

  function startPolling(running: Running, { emitState, update }: Transition<SchedulerMachine>): void {
    const stopPoll = poll.start(() => {
      update({ kind: 'ticked' });
    }, SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS);
    emitState({ kind: 'polling', stopPoll, ...pickRunning(running) });
  }

  /**
   * Removes `record` from the store, under its lock where the browser has Web Locks. Resolves whether this tab removed
   * it. Rejects with `signal`'s reason once it aborted, and when the store cannot remove it.
   */
  function claim(record: ScheduledNotificationRecord, signal: AbortSignal): Promise<boolean> {
    if (locks === undefined) {
      // The IDB delete still claims the record alone.
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

  /** Opens the channel to the other tabs, whose every message wakes the poller. */
  function openWakeChannel(update: Transition<SchedulerMachine>['update']): BroadcastChannel | null {
    const channel = openChannel(BROADCAST_CHANNEL_NAME);
    if (channel !== null) {
      channel.onmessage = () => {
        update({ kind: 'woken' });
      };
    }
    return channel;
  }

  /** Follows the page as it shows, hides and comes back from the back-forward cache, until the returned stop. */
  function listenForPage(update: Transition<SchedulerMachine>['update']): () => void {
    const stopVisible = listenForDocumentVisible(visibility, () => {
      update({ kind: 'woken' });
    });

    // IDB starts closing as unload begins, so a later tick throws `InvalidStateError`. `pagehide`, not
    // `beforeunload`, because it also fires on the bfcache path.
    const stopHide = listen({
      target: lifecycle,
      type: 'pagehide',
      handler: () => {
        update({ kind: 'pageHidden' });
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
        update({ kind: 'pageRestored' });
      },
    });

    return stop;

    function stop(): void {
      stopVisible();
      stopHide();
      stopShow();
    }
  }
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

function pickRunning({ stopListening, channel, lifetime }: Running): Running {
  return { stopListening, channel, lifetime };
}

/** Stops the poller where one runs, and closes the channel. */
function stopWaking(state: Extract<SchedulerState, { kind: AwakeKind }>): void {
  switch (state.kind) {
    case 'polling':
    case 'ticking':
      state.stopPoll();
      break;
    case 'idle':
    case 'rehydrating':
      break;
  }
  state.channel?.close();
}

/** A round at load or restore fires what it finds as `rehydrate`, and a tick's as `realtime`. */
function getFireSource({ kind }: RoundState): FireSource {
  switch (kind) {
    case 'rehydrating':
      return 'rehydrate';
    case 'ticking':
      return 'realtime';
  }
}
