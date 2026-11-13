// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Any tab on the product origin fires a past-due record, and the delete that claims it lets one tab only show it. A
// hidden tab lags by an offset so a visible sibling claims it first.

import type { ProductId } from '@parity/truapi';
import type { scheduledNotifications, ScheduledNotificationRecord } from '@dotli/storage';
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
import { claimScheduledNotification } from './claimScheduledNotification.js';
import { createNotificationsPollReport, type PollStep } from './createNotificationsPollReport.js';

const report = createReporter({ flow: 'notifications' });

/** Count. A transition of the scheduler threw. Tagged `outcome` (error) and `reason` (the error's name). */
const notificationsTransitionMetric = defineCount<'error'>('notifications.transition');

export type ScheduleNotificationResult =
  { ok: true; id: number; immediate: boolean } | { ok: false; error: 'ScheduleLimitReached' };

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

export type ScheduledNotifications = ReturnType<typeof createScheduledNotifications>;

type WakeMessage = { kind: 'scheduled' } | { kind: 'cancelled' } | { kind: 'fired'; hostId: number };

type FireSource = 'realtime' | 'rehydrate';

/** A round's step. A step's events carry the `Round` value they were started for. */
type Round =
  | { kind: 'removingStale' }
  | { kind: 'listing' }
  // Claims the first of `due`.
  | { kind: 'claiming'; due: readonly [ScheduledNotificationRecord, ...ScheduledNotificationRecord[]] };

type ClaimingRound = Extract<Round, { kind: 'claiming' }>;

/**
 * What the scheduler holds from `init` to `dispose`: its page listeners, and a lifetime that aborts on dispose, so a
 * claim in flight starts no delete.
 */
type Page = { stopListening: () => void; lifetime: AbortController };

/** `rehydrating` fires what fell due as `rehydrate`, and `ticking` as `realtime`. A shown page holds the channel. */
type SchedulerState =
  | { kind: 'uninitialized' }
  | { kind: 'idle'; page: Page; channel: BroadcastChannel | null }
  | { kind: 'polling'; page: Page; channel: BroadcastChannel | null; stopPoll: () => void }
  | { kind: 'rehydrating'; page: Page; channel: BroadcastChannel | null; round: Round }
  | {
      kind: 'ticking';
      page: Page;
      channel: BroadcastChannel | null;
      stopPoll: () => void;
      round: Round;
      /**
       * A notification was scheduled meanwhile, so the round's list may predate it and an empty list does not stop the
       * poller.
       */
      rescan: boolean;
    }
  | { kind: 'hidden'; page: Page }
  | { kind: 'disposed' };

/** The kinds that run a round. */
type RoundState = Extract<SchedulerState, { kind: 'rehydrating' | 'ticking' }>;

/** The kinds of a shown page. */
type AwakeState = Extract<SchedulerState, { kind: 'idle' | 'polling' | 'rehydrating' | 'ticking' }>;

type SchedulerEvent =
  | { kind: 'initialized' }
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
  | { kind: 'initialized' }
  | { kind: 'stepSucceeded'; step: PollStep }
  | { kind: 'stepFailed'; step: PollStep; error: unknown }
  | { kind: 'fired'; record: ScheduledNotificationRecord; source: FireSource }
  | { kind: 'posted'; channel: BroadcastChannel | null; message: WakeMessage }
  | { kind: 'channelClosed'; channel: BroadcastChannel | null }
  /** The poller or the page listeners let go of. */
  | { kind: 'stopped'; stop: () => void }
  | { kind: 'lifetimeEnded'; lifetime: AbortController };

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
          transition.emitState({ kind: 'idle', page: state.page, channel: state.channel });
          transition.emitSideEffect({ kind: 'stopped', stop: state.stopPoll });
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
  /**
   * Shows a record this tab removed, whatever round claimed it and also once the scheduler is disposed, since the
   * delete is what claims it and the store no longer holds it for anyone else.
   */
  const fireClaimed: HandlerOf<SchedulerMachine, AwakeState['kind'] | 'hidden' | 'disposed', 'claimed'> = (
    state,
    { record, removed, source },
    { emitSideEffect },
  ) => {
    if (!removed) {
      return;
    }
    emitSideEffect({ kind: 'fired', record, source });
    // A hidden or disposed page's channel closed as it hid or was disposed.
    if (state.kind !== 'hidden' && state.kind !== 'disposed') {
      emitSideEffect({ kind: 'posted', channel: state.channel, message: { kind: 'fired', hostId: record.hostId } });
    }
  };
  /** Shows the claimed record, then claims the next due one when the claim is this round's. */
  const settleClaim: HandlerOf<SchedulerMachine, 'rehydrating' | 'ticking', 'claimed'> = (state, event, transition) => {
    fireClaimed(state, event, transition);
    if (event.round !== state.round) {
      return;
    }
    const [, ...rest] = event.round.due;
    transition.emitSideEffect({ kind: 'stepSucceeded', step: 'claim' });
    claimNext(state, rest, transition);
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
  const announceScheduled: HandlerOf<SchedulerMachine, 'polling' | 'rehydrating' | 'ticking', 'scheduled'> = (
    { channel },
    _event,
    { emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'posted', channel, message: { kind: 'scheduled' } });
  };
  const announceCancelled: HandlerOf<SchedulerMachine, AwakeState['kind'], 'cancelled'> = (
    { channel },
    _event,
    { emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'posted', channel, message: { kind: 'cancelled' } });
  };
  /** Stops the poller and closes the channel, since IDB starts closing as the page unloads. */
  const hide: HandlerOf<SchedulerMachine, AwakeState['kind'], 'pageHidden'> = (state, _event, transition) => {
    transition.emitState({ kind: 'hidden', page: state.page });
    stopWaking(state, transition);
  };
  const shutDown: HandlerOf<SchedulerMachine, AwakeState['kind'] | 'hidden', 'disposed'> = (
    state,
    _event,
    transition,
  ) => {
    transition.emitState({ kind: 'disposed' });
    transition.emitSideEffect({ kind: 'lifetimeEnded', lifetime: state.page.lifetime });
    transition.emitSideEffect({ kind: 'stopped', stop: state.page.stopListening });
    // A hidden page's poller and channel stopped as it hid.
    if (state.kind !== 'hidden') {
      stopWaking(state, transition);
    }
  };
  const pollReport = createNotificationsPollReport();
  const machine = createStateMachine<SchedulerMachine>({
    initial: { kind: 'uninitialized' },
    handlers: {
      uninitialized: {
        initialized(_state, _event, transition) {
          const page = { stopListening: listenForPage(transition.update), lifetime: new AbortController() };
          const channel = openWakeChannel(transition.update);
          transition.emitSideEffect({ kind: 'initialized' });
          runStep({ kind: 'rehydrating', round: { kind: 'removingStale' }, page, channel }, transition);
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
          transition.emitSideEffect({ kind: 'posted', channel: state.channel, message: { kind: 'scheduled' } });
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
        scheduled(state, _event, { emitState, emitSideEffect }) {
          emitState({ ...state, rescan: true });
          emitSideEffect({ kind: 'posted', channel: state.channel, message: { kind: 'scheduled' } });
        },
        cancelled: announceCancelled,
        pageHidden: hide,
        disposed: shutDown,
      },
      // A round the page hid in reports nothing, since its connection closes as the page unloads.
      hidden: {
        claimed: fireClaimed,
        pageRestored({ page }, _event, transition) {
          const channel = openWakeChannel(transition.update);
          runStep({ kind: 'rehydrating', round: { kind: 'removingStale' }, page, channel }, transition);
        },
        disposed: shutDown,
      },
      // A claim whose delete was already running when the scheduler was disposed still shows what it removed.
      disposed: { claimed: fireClaimed },
    },
    onEffect(effect) {
      switch (effect.kind) {
        case 'initialized':
          log.debug('Scheduled notifications: init');
          return;
        case 'stepSucceeded':
          pollReport.succeeded(effect.step);
          return;
        case 'stepFailed':
          pollReport.failed(effect.step, effect.error);
          return;
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
        case 'posted':
          effect.channel?.postMessage(effect.message);
          return;
        case 'channelClosed':
          effect.channel?.close();
          return;
        case 'stopped':
          effect.stop();
          return;
        case 'lifetimeEnded':
          effect.lifetime.abort(new Error('The notification scheduler was disposed'));
          return;
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
     * Stops the poller, closes the channel and stops hearing the page, so a round in flight claims nothing more, while
     * a claim whose delete is already running still shows the notification it removed. An `init` or a restore after it
     * starts nothing, a `schedule` or `cancel` still settles as the store answers, and it is safe to call twice or
     * after a failed round and never throws.
     */
    dispose,
  };

  function init(): void {
    machine.update({ kind: 'initialized' });
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
        const source = state.kind === 'rehydrating' ? 'rehydrate' : 'realtime';
        update(
          claimScheduledNotification({ store, locks, record, signal: state.page.lifetime.signal }).then(
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
        transition.emitState({ kind: 'polling', page: state.page, channel: state.channel, stopPoll: state.stopPoll });
        return;
    }
  }

  function startPolling(
    { page, channel }: Extract<SchedulerState, { kind: 'idle' | 'rehydrating' }>,
    { emitState, update }: Transition<SchedulerMachine>,
  ): void {
    const stopPoll = poll.start(() => {
      update({ kind: 'ticked' });
    }, SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS);
    emitState({ kind: 'polling', page, channel, stopPoll });
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

/** Stops the poller where one runs, and closes the channel. */
function stopWaking(state: AwakeState, { emitSideEffect }: Transition<SchedulerMachine>): void {
  switch (state.kind) {
    case 'polling':
    case 'ticking':
      emitSideEffect({ kind: 'stopped', stop: state.stopPoll });
      break;
    case 'idle':
    case 'rehydrating':
      break;
  }
  emitSideEffect({ kind: 'channelClosed', channel: state.channel });
}
