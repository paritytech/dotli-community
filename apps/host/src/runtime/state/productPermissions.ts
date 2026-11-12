// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The permissions of the product on show. The core persists them, so the store holds what was last read or written.
// Every write, from the panel or a prompt, goes through one path that retries and announces once, and the work runs one
// at a time, so a read never lands over a newer write.

import { createReporter, defineCount } from '@dotli/metrics';
import {
  combineErrors,
  createListenerSet,
  createSharedRun,
  createStateMachine,
  isShallowEqual,
  listen,
  realTimers,
  type HandlerOf,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';
import { computed, type ReadableAtom } from 'nanostores';
import type { PermissionAuthorizations } from '../createPermissionAuthorizations.js';
import {
  ALL_PERMISSIONS,
  hasFrameDirective,
  type EnforceablePermissionName,
  type PermissionStatus,
  type PermissionTargets,
} from '../permissionPolicy.js';
import { toBlockingModalAbortError } from '../throwIfModalAborted.js';
import type { ProductState } from './productState.js';

const uiReport = createReporter({ flow: 'ui' });
const walletReport = createReporter({ flow: 'wallet' });

/**
 * One read of the loaded product's permissions. Tagged `outcome` and, on error, `reason`, as a failed one leaves the
 * menu without statuses.
 */
const permissionsReadMetric = defineCount<'error' | 'ok'>('permissions.read');

/**
 * A permission change, from the panel or a prompt, counted once when it settles. Tagged `outcome` and, on error,
 * `reason` (`write`), as a failed one leaves the permissions it names as they were.
 */
const permissionsChangeMetric = defineCount<'error' | 'ok'>('permissions.change');

/** A transition of the store that threw. */
const permissionsTransitionMetric = defineCount<'error'>('permissions.transition');

/** `statuses` follow the menu order of `ALL_PERMISSIONS`. */
export type ProductPermissionsState =
  | { status: 'none' }
  | { status: 'reading'; label: string }
  | { status: 'read'; label: string; statuses: readonly PermissionStatus[] }
  | { status: 'failed'; label: string };

/** The statuses read, in the menu order of `ALL_PERMISSIONS`, and the product they belong to. */
export type PermissionsRead = { label: string; statuses: readonly PermissionStatus[] };

/** The panel change not yet settled, whose targets the panel shows over the statuses read. */
export type PendingPermissions = { label: string; targets: PermissionTargets } | null;

export type PermissionsChange = {
  label: string;
  /** In menu order, only those whose status changed. */
  permissions: readonly EnforceablePermissionName[];
  /** The frame's `allow` attribute changed, and the frame must be rebuilt, as the attribute is fixed at load. */
  allowChanged: boolean;
  /** The change answers the product's own prompt, whose response has not reached the product yet. */
  fromPrompt: boolean;
};

/** A lasting answer from the product's prompt. A one-time grant is the core's own and never reaches the store. */
export type PromptDecision = 'granted' | 'denied';

/** How a panel change settled. */
export type ChangeOutcome = {
  /** In menu order, the permissions whose write still failed after the last attempt. */
  failed: readonly EnforceablePermissionName[];
};

export type ProductPermissions = ReturnType<typeof createProductPermissions>;

type Params = {
  /** The core's permission store. */
  registry: Pick<PermissionAuthorizations, 'getStatuses' | 'setStatus'>;
  /** The product on show, whose permissions the store holds. */
  product: ReadableAtom<ProductState>;
  /** What a retry waits on. The page's own timers by default. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
};

type RecordPromptDecisionParams = {
  label: string;
  name: EnforceablePermissionName;
  decision: PromptDecision;
  /** The prompt's own signal. Once it aborts, the decision changes nothing. */
  signal: AbortSignal;
};

type ReadJob = { kind: 'read'; waiters: readonly (() => void)[] };

type ChangeJob = {
  kind: 'change';
  label: string;
  targets: PermissionTargets;
  settle: (outcome: ChangeOutcome) => void;
};

/** A prompt's answer, never superseded. A prompt that closes rejects it and shows nothing. */
type DecisionJob = {
  kind: 'decision';
  label: string;
  name: EnforceablePermissionName;
  decision: PromptDecision;
  prompt: AbortSignal;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type Job = ReadJob | ChangeJob | DecisionJob;

/** A running decision listens to its prompt, so a prompt that closes stops the run. */
type RunningDecision = DecisionJob & { stopListening: () => void };

type RunningWrite = ChangeJob | RunningDecision;

/**
 * The work waiting behind the running job, and what the store shows. `shown` names the product on show, as the last
 * load or refresh found it.
 */
type Store = { shown: ProductPermissionsState; queue: readonly Job[] };

/** A write run under way. */
type Write = {
  job: RunningWrite;
  attempt: number;
  /** The names the next attempt writes, those whose last write failed. */
  failing: readonly EnforceablePermissionName[];
  /** The statuses read before the run, fixed for the run. */
  before: readonly PermissionStatus[] | null;
};

/** A write run's steps are kinds of the store, since each step's end moves the store. */
type PermissionsState =
  | { kind: 'idle'; shown: ProductPermissionsState }
  | ({ kind: 'reading'; label: string; job: ReadJob } & Store)
  | ({ kind: 'sending' } & Write & Store)
  /** A newer change superseded the run: the writes already sent finish, and then the run does, with no retry. */
  | ({ kind: 'stopping' } & Write & Store)
  /** The prompt closed: the writes already sent finish, and then the decision rejects and nothing changes. */
  | ({ kind: 'abandoning'; job: RunningDecision } & Store)
  | ({ kind: 'retrying'; errors: readonly unknown[]; timer: unknown } & Write & Store)
  | ({
      kind: 'rereading';
      job: RunningWrite;
      label: string;
      failed: readonly EnforceablePermissionName[];
      errors: readonly unknown[];
    } & Store);

type BusyKind = Exclude<PermissionsState['kind'], 'idle'>;

type PermissionsEvent =
  | { kind: 'refreshAsked'; label: string | null; resolve: () => void }
  | { kind: 'changeAsked'; job: ChangeJob }
  | { kind: 'decisionAsked'; job: DecisionJob }
  | { kind: 'productShown'; label: string | null }
  | { kind: 'statusesRead'; statuses: readonly PermissionStatus[] }
  | { kind: 'statusesFailed'; error: unknown }
  | { kind: 'sent'; failing: readonly EnforceablePermissionName[]; errors: readonly unknown[] }
  | { kind: 'retryDue' }
  | { kind: 'promptClosed' };

type PermissionsEffect =
  | { kind: 'read' }
  | { kind: 'readFailed'; error: unknown }
  | { kind: 'changed' }
  | { kind: 'changeFailed'; errors: readonly unknown[] }
  | { kind: 'announced'; change: PermissionsChange }
  | { kind: 'refreshed'; waiters: readonly (() => void)[] }
  | {
      kind: 'writeSettled';
      job: ChangeJob | DecisionJob;
      failed: readonly EnforceablePermissionName[];
      errors: readonly unknown[];
    }
  | { kind: 'decisionAborted'; job: DecisionJob }
  | { kind: 'promptUnheard'; stopListening: () => void }
  | { kind: 'retryCancelled'; timer: unknown };

type PermissionsMachine = MachineTypes<PermissionsState, PermissionsEvent, PermissionsEffect>;

const NAMES: readonly EnforceablePermissionName[] = ALL_PERMISSIONS.map(({ name }) => name);

const NONE: ProductPermissionsState = { status: 'none' };

/** Builds the permissions store of the product on show, over the core's `registry`. Building one reads nothing. */
export function createProductPermissions({ registry, product, timers = realTimers }: Params) {
  // One listener's failure must not keep the change from the others.
  const changes = createListenerSet<PermissionsChange>({
    onListenerError: uiReport.listener('product_permissions.change'),
  });

  const queueRefresh: HandlerOf<PermissionsMachine, BusyKind, 'refreshAsked'> = (
    state,
    { label, resolve },
    { emitState },
  ) => {
    emitState({ ...state, shown: getShownFor(state.shown, label), queue: joinRead(state.queue, [resolve]) });
  };

  const queueDecision: HandlerOf<PermissionsMachine, BusyKind, 'decisionAsked'> = (state, { job }, { emitState }) => {
    emitState({ ...state, queue: [...state.queue, job] });
  };

  /** Queues a change behind a run it does not supersede, in place of the change queued before it. */
  const queueChange: HandlerOf<
    PermissionsMachine,
    'reading' | 'stopping' | 'abandoning' | 'rereading',
    'changeAsked'
  > = (state, { job }, transition) => {
    transition.emitState({ ...state, queue: replaceQueuedChange(state.queue, job, transition) });
  };

  /** Reads on every load, a reload of the same product included. */
  const followProduct: HandlerOf<PermissionsMachine, BusyKind, 'productShown'> = (state, { label }, { emitState }) => {
    emitState({
      ...state,
      shown: getShownFor(state.shown, label),
      queue: label === null ? state.queue : joinRead(state.queue, []),
    });
  };

  const landRead: HandlerOf<PermissionsMachine, 'reading' | 'rereading', 'statusesRead'> = (
    state,
    { statuses },
    transition,
  ) => {
    transition.emitSideEffect({ kind: 'read' });
    const { label } = state;
    endRead(
      state,
      land(state.shown, { status: 'read', label, statuses: NAMES.map((_, i) => statuses[i] ?? 'ask') }),
      transition,
    );
  };

  const landFailedRead: HandlerOf<PermissionsMachine, 'reading' | 'rereading', 'statusesFailed'> = (
    state,
    { error },
    transition,
  ) => {
    transition.emitSideEffect({ kind: 'readFailed', error });
    endRead(state, land(state.shown, { status: 'failed', label: state.label }), transition);
  };

  const machine = createStateMachine<PermissionsMachine>({
    initial: { kind: 'idle', shown: NONE },
    handlers: {
      idle: {
        refreshAsked({ shown }, { label, resolve }, transition) {
          startNext({ shown: getShownFor(shown, label), queue: [{ kind: 'read', waiters: [resolve] }] }, transition);
        },
        changeAsked({ shown }, { job }, transition) {
          startNext({ shown, queue: [job] }, transition);
        },
        decisionAsked({ shown }, { job }, transition) {
          startNext({ shown, queue: [job] }, transition);
        },
        productShown({ shown }, { label }, transition) {
          startNext(
            { shown: getShownFor(shown, label), queue: label === null ? [] : [{ kind: 'read', waiters: [] }] },
            transition,
          );
        },
      },
      reading: {
        refreshAsked: queueRefresh,
        changeAsked: queueChange,
        decisionAsked: queueDecision,
        productShown: followProduct,
        statusesRead: landRead,
        statusesFailed: landFailedRead,
      },
      sending: {
        refreshAsked: queueRefresh,
        decisionAsked: queueDecision,
        productShown: followProduct,
        changeAsked(state, { job }, transition) {
          const queue = replaceQueuedChange(state.queue, job, transition);
          // A newer change supersedes a running one, whose writes already sent still finish.
          transition.emitState(
            state.job.kind === 'change' ? { ...state, kind: 'stopping', queue } : { ...state, queue },
          );
        },
        promptClosed({ job, shown, queue }, _event, { emitState }) {
          // Only a decision hears its prompt.
          if (job.kind !== 'decision') {
            return;
          }
          emitState({ kind: 'abandoning', job, shown, queue });
        },
        sent(state, { failing, errors }, transition) {
          // Three attempts in all, the first included.
          if (failing.length === 0 || state.attempt === 3) {
            finishWrite({ ...state, failing, errors }, transition);
            return;
          }
          const timer = timers.setTimeout(() => {
            transition.update({ kind: 'retryDue' });
          }, 300);
          transition.emitState({ ...state, kind: 'retrying', failing, errors, timer });
        },
      },
      stopping: {
        refreshAsked: queueRefresh,
        changeAsked: queueChange,
        decisionAsked: queueDecision,
        productShown: followProduct,
        sent(state, { failing, errors }, transition) {
          finishWrite({ ...state, failing, errors }, transition);
        },
      },
      abandoning: {
        refreshAsked: queueRefresh,
        changeAsked: queueChange,
        decisionAsked: queueDecision,
        productShown: followProduct,
        sent(state, _event, transition) {
          abandonDecision(state, transition);
        },
      },
      retrying: {
        refreshAsked: queueRefresh,
        decisionAsked: queueDecision,
        productShown: followProduct,
        changeAsked(state, { job }, transition) {
          const queue = replaceQueuedChange(state.queue, job, transition);
          if (state.job.kind !== 'change') {
            transition.emitState({ ...state, queue });
            return;
          }
          // A newer change supersedes a running one, which makes no more attempts.
          finishWrite({ ...state, queue }, transition);
          transition.emitSideEffect({ kind: 'retryCancelled', timer: state.timer });
        },
        promptClosed(state, _event, transition) {
          // Only a decision hears its prompt.
          if (state.job.kind !== 'decision') {
            return;
          }
          abandonDecision({ ...state, job: state.job }, transition);
          transition.emitSideEffect({ kind: 'retryCancelled', timer: state.timer });
        },
        retryDue(state, _event, transition) {
          send({ ...state, attempt: state.attempt + 1 }, transition);
        },
      },
      rereading: {
        refreshAsked: queueRefresh,
        changeAsked: queueChange,
        decisionAsked: queueDecision,
        productShown: followProduct,
        statusesRead: landRead,
        statusesFailed: landFailedRead,
      },
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'read':
          permissionsReadMetric.count({ outcome: 'ok' });
          return;
        case 'readFailed':
          walletReport.defect(effect.error, {
            step: 'permissions_read',
            metric: permissionsReadMetric,
            message: '[dot.li] permissions read failed:',
            reason: 'read',
          });
          return;
        case 'changed':
          permissionsChangeMetric.count({ outcome: 'ok' });
          return;
        case 'changeFailed':
          walletReport.defect(combineErrors(effect.errors, 'some permissions kept their status'), {
            step: 'permissions_change',
            metric: permissionsChangeMetric,
            message: '[dot.li] permissions change failed:',
            reason: 'write',
            tags: { reason: 'write' },
          });
          return;
        case 'announced':
          changes.emit(effect.change);
          return;
        case 'refreshed':
          for (const waiter of effect.waiters) {
            waiter();
          }
          return;
        case 'writeSettled':
          settleWrite(effect.job, effect.failed, effect.errors);
          return;
        case 'decisionAborted':
          effect.job.reject(toBlockingModalAbortError(effect.job.prompt.reason));
          return;
        case 'promptUnheard':
          effect.stopListening();
          return;
        case 'retryCancelled':
          timers.clearTimeout(effect.timer);
          return;
      }
    },
    onError: error => {
      walletReport.defect(error, {
        step: 'permissions_transition',
        metric: permissionsTransitionMetric,
        message: '[dot.li] A transition of the permissions store threw:',
      });
    },
  });

  const state = computed(machine.state, current => current.shown);
  state.eq = isSameState;
  const pending = computed(machine.state, (current): PendingPermissions => {
    const jobs = current.kind === 'idle' ? [] : [current.job, ...current.queue];
    // A queued change is newer than the running one.
    const change = jobs.filter(job => job.kind === 'change').at(-1);
    return change === undefined ? null : { label: change.label, targets: change.targets };
  });
  pending.eq = isShallowEqual;

  const run = createSharedRun({ begin: beginFollowing });

  return {
    /** The permissions of the product on show, as last read or written. */
    state,
    /** The panel change not yet settled. */
    pending,
    /**
     * Subscribes to every change this store makes and returns the unsubscribe. A listener that throws is reported, and
     * the others still hear the change.
     */
    subscribeChanges: changes.subscribe,
    /**
     * Reads the statuses again. Calls that queue behind a read share the next one. Never rejects, as a failed read is
     * reported and the store shows it failed.
     */
    refresh,
    /**
     * A change made in the panel. A newer one supersedes it: dropped while queued, no more retries while running. Never
     * rejects, as a failure is reported, the store read again and the failed permissions resolved. A write that lands
     * while the statuses are unread reads them again.
     */
    change,
    /**
     * A decision from the product's own prompt, never superseded. A write that still fails after the last attempt
     * rejects, so the product hears it, and an aborted prompt changes nothing once its writes are back. A write that
     * lands while the statuses are unread reads them again.
     */
    recordPromptDecision,
    /**
     * Reads on every load, a reload of the same product included. Each call returns its own stop, a call while
     * following joins the follow, and the follow ends with the last stop. Never throws.
     */
    start,
  };

  function refresh(): Promise<void> {
    return new Promise(resolve => {
      machine.update({ kind: 'refreshAsked', label: getLabelOnShow(), resolve });
    });
  }

  function change(label: string, targets: PermissionTargets): Promise<ChangeOutcome> {
    return new Promise(settle => {
      machine.update({ kind: 'changeAsked', job: { kind: 'change', label, targets, settle } });
    });
  }

  function recordPromptDecision({ label, name, decision, signal }: RecordPromptDecisionParams): Promise<void> {
    return new Promise((resolve, reject) => {
      machine.update({
        kind: 'decisionAsked',
        job: { kind: 'decision', label, name, decision, prompt: signal, resolve, reject },
      });
    });
  }

  function start(): () => void {
    return run.join();
  }

  function beginFollowing(): () => void {
    return product.subscribe(() => {
      machine.update({ kind: 'productShown', label: getLabelOnShow() });
    });
  }

  function getLabelOnShow(): string | null {
    const shown = product.get();
    return shown.status === 'loaded' ? shown.label : null;
  }

  /** Starts the first job of `queue`, or rests in `idle` when none waits. */
  function startNext({ shown, queue }: Store, transition: Transition<PermissionsMachine>): void {
    const [job, ...rest] = queue;
    if (job === undefined) {
      transition.emitState({ kind: 'idle', shown });
      return;
    }
    const store = { shown, queue: rest };
    switch (job.kind) {
      case 'read':
        startRead(store, job, transition);
        return;
      case 'change':
      case 'decision':
        startWrite(store, job, transition);
        return;
    }
  }

  /** Reads the product on show. With none on show, the read is done at once. */
  function startRead(store: Store, job: ReadJob, transition: Transition<PermissionsMachine>): void {
    const label = getShownLabel(store.shown);
    if (label === null) {
      startNext(store, transition);
      transition.emitSideEffect({ kind: 'refreshed', waiters: job.waiters });
      return;
    }
    transition.emitState({ kind: 'reading', label, job, ...store });
    readStatuses(label, transition.update);
  }

  function readStatuses(label: string, update: Transition<PermissionsMachine>['update']): void {
    update(
      registry.getStatuses(label, NAMES).then(
        (statuses): PermissionsEvent => ({ kind: 'statusesRead', statuses }),
        (error: unknown): PermissionsEvent => ({ kind: 'statusesFailed', error }),
      ),
    );
  }

  /** Ends a read showing `shown`, then resolves its waiters or settles the write run it read for. */
  function endRead(
    state: Extract<PermissionsState, { kind: 'reading' | 'rereading' }>,
    shown: ProductPermissionsState,
    transition: Transition<PermissionsMachine>,
  ): void {
    startNext({ shown, queue: state.queue }, transition);
    switch (state.kind) {
      case 'reading':
        transition.emitSideEffect({ kind: 'refreshed', waiters: state.job.waiters });
        return;
      case 'rereading':
        transition.emitSideEffect({ kind: 'writeSettled', job: state.job, failed: state.failed, errors: state.errors });
        return;
    }
  }

  /** Starts a write run, or settles a job with nothing to write or whose prompt already closed. */
  function startWrite(store: Store, job: ChangeJob | DecisionJob, transition: Transition<PermissionsMachine>): void {
    const targets = getTargets(job);
    const names = NAMES.filter(name => targets[name] !== undefined);
    const before = getReadStatuses(store.shown, job.label);
    switch (job.kind) {
      case 'change':
        // With the statuses unread nothing is known to match, so every target is written.
        if (before !== null && names.every(name => getPermissionStatus(before, name) === targets[name])) {
          startNext(store, transition);
          transition.emitSideEffect({ kind: 'writeSettled', job, failed: [], errors: [] });
          return;
        }
        send({ job, attempt: 1, failing: names, before, ...store }, transition);
        return;
      case 'decision': {
        if (job.prompt.aborted) {
          startNext(store, transition);
          transition.emitSideEffect({ kind: 'decisionAborted', job });
          return;
        }
        const stopListening = listen({
          target: job.prompt,
          type: 'abort',
          handler: () => {
            transition.update({ kind: 'promptClosed' });
          },
        });
        // Written even where it matches the statuses read. A prompt asks only at Ask, as the core said just then, so
        // the statuses read may be stale, and a skipped write would drop the answer.
        send({ job: { ...job, stopListening }, attempt: 1, failing: names, before, ...store }, transition);
        return;
      }
    }
  }

  /** Sends one attempt, writing each name of `failing`. */
  function send(
    { job, attempt, failing, before, shown, queue }: Write & Store,
    { emitState, update }: Transition<PermissionsMachine>,
  ): void {
    emitState({ kind: 'sending', job, attempt, failing, before, shown, queue });
    const targets = getTargets(job);
    update(
      Promise.allSettled(
        failing.map(name => registry.setStatus({ label: job.label, permission: name, status: targets[name] ?? 'ask' })),
      ).then((results): PermissionsEvent => ({
        kind: 'sent',
        failing: failing.filter((_, i) => results[i]?.status === 'rejected'),
        errors: results.flatMap((result): unknown[] => (result.status === 'rejected' ? [result.reason] : [])),
      })),
    );
  }

  /** Ends a write run: shows and announces what landed, then reads again or settles the job. */
  function finishWrite(
    { job, failing, errors, before, ...store }: Write & Store & { errors: readonly unknown[] },
    transition: Transition<PermissionsMachine>,
  ): void {
    const { emitState, emitSideEffect, update } = transition;
    const targets = getTargets(job);
    const landed = NAMES.filter(name => targets[name] !== undefined && !failing.includes(name));
    const current = getReadStatuses(store.shown, job.label);
    // Only statuses read are patched, so a write over unread ones shows nothing yet.
    const shown =
      current !== null
        ? land(store.shown, {
            status: 'read',
            label: job.label,
            statuses: NAMES.map((name, i) =>
              landed.includes(name) ? (targets[name] ?? 'ask') : (current[i] ?? 'ask'),
            ),
          })
        : store.shown;
    const change = getLandedChange(job, landed, before);
    if (change !== null) {
      emitSideEffect({ kind: 'announced', change });
    }
    emitSideEffect(failing.length > 0 ? { kind: 'changeFailed', errors } : { kind: 'changed' });
    const label = getShownLabel(shown);
    // A failed write shows what the core kept, not what was asked for. A write over unread statuses reads them, but
    // only for the product on show.
    if (label !== null && (failing.length > 0 || (landed.length > 0 && current === null && label === job.label))) {
      emitState({ kind: 'rereading', job, label, failed: failing, errors, shown, queue: store.queue });
      readStatuses(label, update);
    } else {
      startNext({ shown, queue: store.queue }, transition);
      emitSideEffect({ kind: 'writeSettled', job, failed: failing, errors });
    }
    if (job.kind === 'decision') {
      emitSideEffect({ kind: 'promptUnheard', stopListening: job.stopListening });
    }
  }

  /** Ends a run whose prompt closed: the decision rejects and nothing changes. */
  function abandonDecision(
    { job, shown, queue }: { job: RunningDecision } & Store,
    transition: Transition<PermissionsMachine>,
  ): void {
    startNext({ shown, queue }, transition);
    transition.emitSideEffect({ kind: 'promptUnheard', stopListening: job.stopListening });
    transition.emitSideEffect({ kind: 'decisionAborted', job });
  }
}

/** The label of the product on show, as `shown` names it. */
function getShownLabel(shown: ProductPermissionsState): string | null {
  return shown.status === 'none' ? null : shown.label;
}

/** A read or write lands only for the product still on show. */
function land(
  shown: ProductPermissionsState,
  next: Exclude<ProductPermissionsState, { status: 'none' }>,
): ProductPermissionsState {
  return getShownLabel(shown) === next.label ? next : shown;
}

/** The change a write run made with the names that `landed`, against the statuses `before` it, or null for none. */
function getLandedChange(
  job: ChangeJob | DecisionJob,
  landed: readonly EnforceablePermissionName[],
  before: readonly PermissionStatus[] | null,
): PermissionsChange | null {
  const targets = getTargets(job);
  const getStatusBefore = (name: EnforceablePermissionName): PermissionStatus | undefined =>
    before === null ? undefined : getPermissionStatus(before, name);
  const changed = landed.filter(name => getStatusBefore(name) !== targets[name]);
  if (changed.length === 0) {
    return null;
  }
  return {
    label: job.label,
    permissions: changed,
    // A status that was never read may have held a grant, so its change asks for a rebuild.
    allowChanged: changed.some(name => {
      const statusBefore = getStatusBefore(name);
      return (
        hasFrameDirective(name) &&
        (statusBefore === undefined || statusBefore === 'granted' || targets[name] === 'granted')
      );
    }),
    fromPrompt: job.kind === 'decision',
  };
}

/** The statuses read and the product they belong to, or undefined while none are read. Never throws. */
export function getRead(state: ProductPermissionsState): PermissionsRead | undefined {
  switch (state.status) {
    case 'read':
      return state;
    case 'none':
    case 'reading':
    case 'failed':
      return undefined;
  }
}

/** Whether the last read of the product `label`'s permissions failed. Never throws. */
export function isUnreadable(state: ProductPermissionsState, label: string): boolean {
  switch (state.status) {
    case 'failed':
      return state.label === label;
    case 'none':
    case 'reading':
    case 'read':
      return false;
  }
}

/** Whether a permission read is granted. Never throws. */
export function hasGrant(state: ProductPermissionsState): boolean {
  return getRead(state)?.statuses.includes('granted') === true;
}

/** `current` is undefined on a computed store's first run. */
function isSameState(current: ProductPermissionsState | undefined, next: ProductPermissionsState): boolean {
  if (
    current?.status !== next.status ||
    (current.status !== 'none' && next.status !== 'none' && current.label !== next.label)
  ) {
    return false;
  }
  if (current.status === 'read' && next.status === 'read') {
    return (
      current.statuses.length === next.statuses.length &&
      current.statuses.every((status, i) => status === next.statuses[i])
    );
  }
  return true;
}

function getPermissionStatus(statuses: readonly PermissionStatus[], name: EnforceablePermissionName): PermissionStatus {
  return statuses[NAMES.indexOf(name)] ?? 'ask';
}

/** Settles a write run's job with what still failed. */
function settleWrite(
  job: ChangeJob | DecisionJob,
  failed: readonly EnforceablePermissionName[],
  errors: readonly unknown[],
): void {
  switch (job.kind) {
    case 'change':
      job.settle({ failed });
      return;
    case 'decision':
      if (failed.length > 0) {
        job.reject(combineErrors(errors, 'the prompt answer was not stored'));
        return;
      }
      job.resolve();
      return;
  }
}

function getTargets(job: ChangeJob | DecisionJob): PermissionTargets {
  switch (job.kind) {
    case 'change':
      return job.targets;
    case 'decision':
      return { [job.name]: job.decision };
  }
}

/** What the store shows once `label` is on show: a new product shows its read under way. */
function getShownFor(shown: ProductPermissionsState, label: string | null): ProductPermissionsState {
  if (label === null) {
    return NONE;
  }
  return shown.status === 'none' || shown.label !== label ? { status: 'reading', label } : shown;
}

function getReadStatuses(shown: ProductPermissionsState, label: string): readonly PermissionStatus[] | null {
  return shown.status === 'read' && shown.label === label ? shown.statuses : null;
}

/** `queue` with `waiters` joined to the read queued in it, or to a new read when none is. */
function joinRead(queue: readonly Job[], waiters: readonly (() => void)[]): readonly Job[] {
  const queued = queue.find(job => job.kind === 'read');
  if (queued === undefined) {
    return [...queue, { kind: 'read', waiters }];
  }
  if (waiters.length === 0) {
    return queue;
  }
  return queue.map(job => (job === queued ? { ...queued, waiters: [...queued.waiters, ...waiters] } : job));
}

/**
 * `queue` with `job` queued last in place of the change queued in it, which settles as having nothing left to write.
 * A queue holds one change at most.
 */
function replaceQueuedChange(
  queue: readonly Job[],
  job: ChangeJob,
  { emitSideEffect }: Transition<PermissionsMachine>,
): readonly Job[] {
  const dropped = queue.find(queued => queued.kind === 'change');
  if (dropped !== undefined) {
    emitSideEffect({ kind: 'writeSettled', job: dropped, failed: [], errors: [] });
  }
  return [...queue.filter(queued => queued !== dropped), job];
}
