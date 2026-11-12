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
type RunningWrite = ChangeJob | (DecisionJob & { stopListening: () => void });

/** The work waiting behind the running job, and what the store shows. */
type Store = { shown: ProductPermissionsState; queue: readonly Job[] };

/** A write run under way. */
type Write = {
  job: RunningWrite;
  attempt: number;
  /** The names the next attempt writes, those whose last write failed. */
  failing: readonly EnforceablePermissionName[];
  /** What the run writes and what it found before it, fixed for the run. */
  written: { names: readonly EnforceablePermissionName[]; before: readonly PermissionStatus[] | null };
};

/** A write run's steps are kinds of the store, since each step's end moves the store. */
type PermissionsState =
  | { kind: 'idle'; shown: ProductPermissionsState }
  | ({ kind: 'reading'; label: string; job: ReadJob } & Store)
  | ({ kind: 'sending' } & Write & Store)
  /** Sending, stopped: the writes already sent finish, and then the run does, with no more attempts. */
  | ({ kind: 'stopping' } & Write & Store)
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
  | { kind: 'refreshAsked'; resolve: () => void }
  | { kind: 'changeAsked'; job: ChangeJob }
  | { kind: 'decisionAsked'; job: DecisionJob }
  | { kind: 'productShown'; label: string | null }
  | { kind: 'statusesRead'; label: string; statuses: readonly PermissionStatus[] }
  | { kind: 'statusesFailed'; label: string; error: unknown }
  | { kind: 'sent'; failing: readonly EnforceablePermissionName[]; errors: readonly unknown[] }
  | { kind: 'retryDue' }
  | { kind: 'promptClosed'; prompt: AbortSignal };

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

  const queueRefresh: HandlerOf<PermissionsMachine, BusyKind, 'refreshAsked'> = (state, { resolve }, { emitState }) => {
    emitState({ ...state, queue: joinRead(state.queue, [resolve]) });
  };

  const queueDecision: HandlerOf<PermissionsMachine, BusyKind, 'decisionAsked'> = (state, { job }, { emitState }) => {
    emitState({ ...state, queue: [...state.queue, job] });
  };

  /** Queues a change behind a run it does not supersede, and drops the change queued before it. */
  const queueChange: HandlerOf<PermissionsMachine, 'reading' | 'stopping' | 'rereading', 'changeAsked'> = (
    state,
    { job },
    { emitState, emitSideEffect },
  ) => {
    emitState({ ...state, queue: withChange(state.queue, job) });
    dropQueuedChanges(state.queue, emitSideEffect);
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
    { label, statuses },
    transition,
  ) => {
    transition.emitSideEffect({ kind: 'read' });
    endRead(
      state,
      land(state.shown, { status: 'read', label, statuses: NAMES.map((_, i) => statuses[i] ?? 'ask') }),
      transition,
    );
  };

  const landFailedRead: HandlerOf<PermissionsMachine, 'reading' | 'rereading', 'statusesFailed'> = (
    state,
    { label, error },
    transition,
  ) => {
    transition.emitSideEffect({ kind: 'readFailed', error });
    endRead(state, land(state.shown, { status: 'failed', label }), transition);
  };

  const machine = createStateMachine<PermissionsMachine>({
    initial: { kind: 'idle', shown: NONE },
    handlers: {
      idle: {
        refreshAsked({ shown }, { resolve }, transition) {
          startNext({ shown, queue: [{ kind: 'read', waiters: [resolve] }] }, transition);
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
        changeAsked(state, { job }, { emitState, emitSideEffect }) {
          const queue = withChange(state.queue, job);
          // A newer change supersedes a running one, whose writes already sent still finish.
          emitState(state.job.kind === 'change' ? { ...state, kind: 'stopping', queue } : { ...state, queue });
          dropQueuedChanges(state.queue, emitSideEffect);
        },
        promptClosed(state, { prompt }, { emitState }) {
          if (state.job.kind !== 'decision' || state.job.prompt !== prompt) {
            return;
          }
          emitState({ ...state, kind: 'stopping' });
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
      retrying: {
        refreshAsked: queueRefresh,
        decisionAsked: queueDecision,
        productShown: followProduct,
        changeAsked(state, { job }, transition) {
          const queue = withChange(state.queue, job);
          if (state.job.kind === 'change') {
            // A newer change supersedes a running one, which makes no more attempts.
            finishWrite({ ...state, queue }, transition);
            transition.emitSideEffect({ kind: 'retryCancelled', timer: state.timer });
          } else {
            transition.emitState({ ...state, queue });
          }
          dropQueuedChanges(state.queue, transition.emitSideEffect);
        },
        promptClosed(state, { prompt }, transition) {
          if (state.job.kind !== 'decision' || state.job.prompt !== prompt) {
            return;
          }
          finishWrite(state, transition);
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
      machine.update({ kind: 'refreshAsked', resolve });
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

  /** A read or write lands only for the product still on show. */
  function land(
    shown: ProductPermissionsState,
    next: Exclude<ProductPermissionsState, { status: 'none' }>,
  ): ProductPermissionsState {
    return getLabelOnShow() === next.label ? next : shown;
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
    const label = getLabelOnShow();
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
        (statuses): PermissionsEvent => ({ kind: 'statusesRead', label, statuses }),
        (error: unknown): PermissionsEvent => ({ kind: 'statusesFailed', label, error }),
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
        send({ job, attempt: 1, failing: names, written: { names, before }, ...store }, transition);
        return;
      case 'decision': {
        if (job.prompt.aborted) {
          startNext(store, transition);
          transition.emitSideEffect({ kind: 'decisionAborted', job });
          return;
        }
        const { prompt } = job;
        const close = () => {
          transition.update({ kind: 'promptClosed', prompt });
        };
        prompt.addEventListener('abort', close, { once: true });
        const running = {
          ...job,
          stopListening: () => {
            prompt.removeEventListener('abort', close);
          },
        };
        // Written even where it matches the statuses read. A prompt asks only at Ask, as the core said just then, so
        // the statuses read may be stale, and a skipped write would drop the answer.
        send({ job: running, attempt: 1, failing: names, written: { names, before }, ...store }, transition);
        return;
      }
    }
  }

  /** Sends one attempt, writing each name of `failing`. */
  function send(
    { job, attempt, failing, written, shown, queue }: Write & Store,
    { emitState, update }: Transition<PermissionsMachine>,
  ): void {
    emitState({ kind: 'sending', job, attempt, failing, written, shown, queue });
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
    { job, failing, errors, written: { names, before }, ...store }: Write & Store & { errors: readonly unknown[] },
    transition: Transition<PermissionsMachine>,
  ): void {
    const { emitState, emitSideEffect, update } = transition;
    if (job.kind === 'decision' && job.prompt.aborted) {
      startNext(store, transition);
      emitSideEffect({ kind: 'promptUnheard', stopListening: job.stopListening });
      emitSideEffect({ kind: 'decisionAborted', job });
      return;
    }
    const targets = getTargets(job);
    const landed = names.filter(name => !failing.includes(name));
    const current = getReadStatuses(store.shown, job.label);
    // Only statuses read are patched, so a write over unread ones shows nothing yet.
    const patched = current !== null && landed.length > 0;
    const shown = patched
      ? land(store.shown, {
          status: 'read',
          label: job.label,
          statuses: NAMES.map((name, i) => (landed.includes(name) ? (targets[name] ?? 'ask') : (current[i] ?? 'ask'))),
        })
      : store.shown;
    const getStatusBefore = (name: EnforceablePermissionName): PermissionStatus | undefined =>
      before === null ? undefined : getPermissionStatus(before, name);
    const changed = landed.filter(name => getStatusBefore(name) !== targets[name]);
    if (changed.length > 0) {
      emitSideEffect({
        kind: 'announced',
        change: {
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
        },
      });
    }
    emitSideEffect(failing.length > 0 ? { kind: 'changeFailed', errors } : { kind: 'changed' });
    const label = getLabelOnShow();
    // A failed write shows what the core kept, not what was asked for. Only the product on show is read, so a write
    // whose product left reads nothing.
    if (label !== null && (failing.length > 0 || (landed.length > 0 && !patched && label === job.label))) {
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

/** `queue` with `job` in place of the change queued in it. */
function withChange(queue: readonly Job[], job: ChangeJob): readonly Job[] {
  return [...queue.filter(queued => queued.kind !== 'change'), job];
}

/** Settles the change queued in `queue`, which a newer one dropped, as having nothing left to write. */
function dropQueuedChanges(
  queue: readonly Job[],
  emitSideEffect: Transition<PermissionsMachine>['emitSideEffect'],
): void {
  for (const job of queue) {
    if (job.kind === 'change') {
      emitSideEffect({ kind: 'writeSettled', job, failed: [], errors: [] });
    }
  }
}
