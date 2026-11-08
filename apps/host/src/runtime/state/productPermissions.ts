// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The permissions of the product on show. The core persists them, so the store holds what was last read or written.
// Every write, from the panel or a prompt, goes through one path that retries and announces once, and the work runs one
// at a time, so a read never lands over a newer write.

import { createReporter, defineCount } from '@dotli/metrics';
import {
  combineErrors,
  createAsyncTaskPool,
  createListenerSet,
  createSharedRun,
  realTimers,
  registerAtomReset,
  type Timers,
} from '@dotli/shared';
import { atom, type ReadableAtom } from 'nanostores';
import type { PermissionAuthorizations } from '../createPermissionAuthorizations.js';
import {
  ALL_PERMISSIONS,
  hasFrameDirective,
  type EnforceablePermissionName,
  type PermissionStatus,
  type PermissionTargets,
} from '../permissionPolicy.js';
import { throwIfModalAborted } from '../throwIfModalAborted.js';
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

type PatchParams = {
  label: string;
  /** The targets whose write landed. */
  landed: readonly EnforceablePermissionName[];
  targets: PermissionTargets;
};

type WriteParams = {
  label: string;
  targets: PermissionTargets;
  /** A panel change superseded by a newer one: dropped while queued, no more attempts while running. */
  superseded?: AbortSignal;
  /** A prompt torn down. Its change rejects and shows nothing, as its answer never reaches the product. */
  prompt?: AbortSignal;
  /**
   * Writes even the targets the statuses read already match. A prompt asks only at Ask, as the core said just then, so
   * the statuses read may be stale, and a skipped write would drop the answer.
   */
  always?: boolean;
  fromPrompt: boolean;
};

type WriteResult = {
  /** In menu order, the targets whose write still failed after the last attempt. */
  failed: EnforceablePermissionName[];
  /** What the last attempt's failed writes threw. */
  errors: unknown[];
};

const NAMES: readonly EnforceablePermissionName[] = ALL_PERMISSIONS.map(({ name }) => name);

/** Attempts per change in all, the first included. */
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 300;

const NONE: ProductPermissionsState = { status: 'none' };

const POOL = 'product-permissions';

/** Builds the permissions store of the product on show, over the core's `registry`. Building one reads nothing. */
export function createProductPermissions({ registry, product, timers = realTimers }: Params) {
  const permissions = atom<ProductPermissionsState>(NONE);
  permissions.eq = isSameState;
  registerAtomReset(permissions);
  const pendingChange = atom<PendingPermissions>(null);
  registerAtomReset(pendingChange);
  const state: ReadableAtom<ProductPermissionsState> = permissions;
  const pending: ReadableAtom<PendingPermissions> = pendingChange;

  // One listener's failure must not keep the change from the others.
  const changes = createListenerSet<PermissionsChange>({
    onListenerError: uiReport.listener('product_permissions.change'),
  });

  // Reads and writes run one at a time, so the store only ever moves forward.
  const work = createAsyncTaskPool({ poolSize: 1 });

  let requested = 0;
  let covered = 0;
  // The latest panel change, which any newer one supersedes.
  let latest: AbortController | null = null;
  const run = createSharedRun({ begin: beginFollowing });

  function refresh(): Promise<void> {
    const ticket = ++requested;
    return work.call(
      async () => {
        // A read that started after this call was made already answers it.
        if (covered >= ticket) {
          return;
        }
        covered = requested;
        await read();
      },
      { pool: POOL },
    );
  }

  function change(label: string, targets: PermissionTargets): Promise<ChangeOutcome> {
    latest?.abort();
    const own = new AbortController();
    latest = own;
    pendingChange.set({ label, targets });
    return work.call(
      async () => {
        try {
          const { failed } = await write({ label, targets, superseded: own.signal, fromPrompt: false });
          return { failed };
        } finally {
          if (latest === own) {
            latest = null;
            pendingChange.set(null);
          }
        }
      },
      { pool: POOL },
    );
  }

  function recordPromptDecision({ label, name, decision, signal }: RecordPromptDecisionParams): Promise<void> {
    return work.call(
      async () => {
        const { errors } = await write({
          label,
          targets: { [name]: decision },
          prompt: signal,
          always: true,
          fromPrompt: true,
        });
        if (errors.length > 0) {
          throw combineErrors(errors, 'the prompt answer was not stored');
        }
      },
      { pool: POOL },
    );
  }

  function start(): () => void {
    return run.join();
  }

  function beginFollowing(): () => void {
    return product.subscribe(followProduct);
  }

  function followProduct(): void {
    const label = getCurrentLabel();
    const current = permissions.get();
    if (label === null) {
      permissions.set(NONE);
      return;
    }
    if (current.status === 'none' || current.label !== label) {
      permissions.set({ status: 'reading', label });
    }
    void refresh();
  }

  function getCurrentLabel(): string | null {
    const shown = product.get();
    return shown.status === 'loaded' ? shown.label : null;
  }

  /** A read or write lands only for the product still on show. */
  function land(label: string, next: ProductPermissionsState): void {
    if (getCurrentLabel() === label) {
      permissions.set(next);
    }
  }

  function readStatuses(label: string): readonly PermissionStatus[] | null {
    const current = permissions.get();
    return current.status === 'read' && current.label === label ? current.statuses : null;
  }

  function patch({ label, landed, targets }: PatchParams): void {
    const current = readStatuses(label);
    if (current === null || landed.length === 0) {
      return;
    }
    land(label, {
      status: 'read',
      label,
      statuses: NAMES.map((name, i) => (landed.includes(name) ? (targets[name] ?? 'ask') : (current[i] ?? 'ask'))),
    });
  }

  async function read(): Promise<void> {
    const label = getCurrentLabel();
    if (label === null) {
      return;
    }
    try {
      const statuses = await registry.getStatuses(label, NAMES);
      permissionsReadMetric.count({ outcome: 'ok' });
      land(label, { status: 'read', label, statuses: NAMES.map((_, i) => statuses[i] ?? 'ask') });
    } catch (error) {
      walletReport.defect(error, {
        step: 'permissions_read',
        metric: permissionsReadMetric,
        message: '[dot.li] permissions read failed:',
        reason: 'read',
      });
      land(label, { status: 'failed', label });
    }
  }

  function reportFailure(errors: readonly unknown[]): void {
    const error = combineErrors(errors, 'some permissions kept their status');
    walletReport.defect(error, {
      step: 'permissions_change',
      metric: permissionsChangeMetric,
      message: '[dot.li] permissions change failed:',
      reason: 'write',
      tags: { reason: 'write' },
    });
  }

  /** Runs in the pool's slot. Writes every target, retries the failed, then shows and announces what landed. */
  async function write({
    label,
    targets,
    superseded,
    prompt,
    always = false,
    fromPrompt,
  }: WriteParams): Promise<WriteResult> {
    if (superseded?.aborted === true) {
      return { failed: [], errors: [] };
    }
    if (prompt !== undefined) {
      throwIfModalAborted(prompt);
    }
    const names = NAMES.filter(name => targets[name] !== undefined);
    const before = readStatuses(label);
    const getStatusBefore = (name: EnforceablePermissionName): PermissionStatus | undefined =>
      before === null ? undefined : getPermissionStatus(before, name);
    // With the statuses unread nothing is known to match, so every target is written.
    if (!always && before !== null && names.every(name => getStatusBefore(name) === targets[name])) {
      return { failed: [], errors: [] };
    }

    let failed = names;
    let errors: unknown[] = [];
    let sending: Promise<void> = Promise.resolve();
    const attempts = createAsyncTaskPool({
      poolSize: 1,
      retryCount: ATTEMPTS - 1,
      retryDelay: RETRY_DELAY_MS,
      timers,
    });
    const signals = [superseded, prompt].filter(signal => signal !== undefined);
    const stopSignal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
    // `failed` and `errors` carry the outcome, so the rejection, the last attempt's or a stop's, adds nothing.
    await attempts.call(attempt, stopSignal === undefined ? {} : { signal: stopSignal }).then(
      () => undefined,
      () => undefined,
    );
    // A stop settles the call at once, but the writes already sent finish first.
    await sending;
    if (prompt !== undefined) {
      throwIfModalAborted(prompt);
    }

    const landed = names.filter(name => !failed.includes(name));
    patch({ label, landed, targets });
    const changed = landed.filter(name => getStatusBefore(name) !== targets[name]);
    if (changed.length > 0) {
      changes.emit({
        label,
        permissions: changed,
        allowChanged: changed.some(
          name => hasFrameDirective(name) && (getStatusBefore(name) === 'granted' || targets[name] === 'granted'),
        ),
        fromPrompt,
      });
    }
    if (failed.length > 0) {
      reportFailure(errors);
      // The store shows what the core kept, not what was asked for.
      await read();
    } else {
      permissionsChangeMetric.count({ outcome: 'ok' });
    }
    return { failed, errors };

    async function attempt(): Promise<void> {
      sending = send();
      await sending;
      if (failed.length > 0) {
        throw new AggregateError(errors, 'some permissions kept their status');
      }
    }

    async function send(): Promise<void> {
      const results = await Promise.allSettled(
        failed.map(name => registry.setStatus({ label, permission: name, status: targets[name] ?? 'ask' })),
      );
      errors = results.flatMap((result): unknown[] => (result.status === 'rejected' ? [result.reason] : []));
      failed = failed.filter((_, i) => results[i]?.status === 'rejected');
    }
  }

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
     * rejects, as a failure is reported, the store read again and the failed permissions resolved.
     */
    change,
    /**
     * A decision from the product's own prompt, never superseded. A write that still fails after the last attempt
     * rejects, so the product hears it, and an aborted prompt changes nothing once its writes are back.
     */
    recordPromptDecision,
    /**
     * Reads on every load, a reload of the same product included. Each call returns its own stop, a call while
     * following joins the follow, and the follow ends with the last stop. Never throws.
     */
    start,
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

function isSameState(current: ProductPermissionsState, next: ProductPermissionsState): boolean {
  if (
    current.status !== next.status ||
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
