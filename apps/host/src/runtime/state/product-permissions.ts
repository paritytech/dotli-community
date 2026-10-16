// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The permissions of the product on show. The core persists them, so the store holds what was last read or written.
// Every write, from the panel or a prompt, goes through one path that retries and announces once, and the work runs one
// at a time, so a read never lands over a newer write. The page builds one, over its own registry and product.

import { captureException, m, reportListener, spans as S } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  createListenerSet,
  createSyncStore,
  log,
  realTimers,
  type ReadableStore,
  type Timers,
} from '@dotli/shared';
import {
  ALL_PERMISSIONS,
  isDevicePermission,
  type EnforceablePermissionName,
  type PermissionAuthorizations,
  type PermissionStatus,
  type PermissionTargets,
} from '../permissions.js';
import { throwIfAborted } from '../blocking-modal-queue.js';
import type { ProductState } from './product.js';

const NAMES: readonly EnforceablePermissionName[] = ALL_PERMISSIONS.map(({ name }) => name);

/** Attempts per change in all, the first included. */
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 300;

/** `statuses` follow the menu order of `ALL_PERMISSIONS`. */
export type ProductPermissionsState =
  | { status: 'none' }
  | { status: 'reading'; label: string }
  | { status: 'read'; label: string; statuses: readonly PermissionStatus[] }
  | { status: 'failed'; label: string };

/** The panel change not yet settled, whose targets the panel shows over the statuses read. */
export type PendingPermissions = { label: string; targets: PermissionTargets } | null;

export interface PermissionsChange {
  label: string;
  /** In menu order, only those whose status changed. */
  permissions: readonly EnforceablePermissionName[];
  /** The frame's `allow` attribute changed, and the frame must be rebuilt, as the attribute is fixed at load. */
  allowChanged: boolean;
  /** The change answers the product's own prompt, whose response has not reached the product yet. */
  fromPrompt: boolean;
}

export type PromptDecision = 'granted' | 'granted-once' | 'denied';

/** How a panel change settled. */
export interface ChangeOutcome {
  /** In menu order, the permissions whose write still failed after the last attempt. */
  failed: readonly EnforceablePermissionName[];
}

const NONE: ProductPermissionsState = { status: 'none' };

function sameState(a: ProductPermissionsState, b: ProductPermissionsState): boolean {
  if (a.status !== b.status || (a.status !== 'none' && b.status !== 'none' && a.label !== b.label)) {
    return false;
  }
  if (a.status === 'read' && b.status === 'read') {
    return a.statuses.length === b.statuses.length && a.statuses.every((status, i) => status === b.statuses[i]);
  }
  return true;
}

function permissionStatusIn(statuses: readonly PermissionStatus[], name: EnforceablePermissionName): PermissionStatus {
  return statuses[NAMES.indexOf(name)] ?? 'ask';
}

export interface ProductPermissionsDeps {
  /** The core's permission store, reached through the connections the product frame opens. */
  registry: Pick<PermissionAuthorizations, 'statuses' | 'setStatus'>;
  /** The product on show, whose permissions the store holds. */
  product: ReadableStore<ProductState>;
  /** What a retry waits on. The page's own timers by default. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
}

export interface ProductPermissions {
  state: ReadableStore<ProductPermissionsState>;
  /** The panel change not yet settled. */
  pending: ReadableStore<PendingPermissions>;
  /** Every change this store makes, for whoever must act on it, such as the frame that reloads for a new policy. */
  onChanged: (listener: (change: PermissionsChange) => void) => () => void;
  /** Reads the statuses again. Calls that queue behind a read share the next one. */
  refresh: () => Promise<void>;
  /**
   * A change made in the panel. A newer one supersedes it: dropped while queued, no more retries while running. Never
   * rejects, as a failure is reported, the store read again and the failed permissions resolved.
   */
  change: (label: string, targets: PermissionTargets) => Promise<ChangeOutcome>;
  /**
   * A decision from the product's own prompt, never superseded. A write that still fails after the last attempt
   * rejects, so the product hears it, and an aborted prompt changes nothing once its writes are back.
   */
  recordPromptDecision: (
    label: string,
    name: EnforceablePermissionName,
    decision: PromptDecision,
    signal: AbortSignal,
  ) => Promise<void>;
  /**
   * Reads on every load, a reload of the same product included, until the returned stop. A second call returns it
   * too.
   */
  start: () => () => void;
}

interface WriteOptions {
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
}

interface WriteResult {
  /** In menu order, the targets whose write still failed after the last attempt. */
  failed: EnforceablePermissionName[];
  /** What the last attempt's failed writes threw. */
  errors: unknown[];
}

export function createProductPermissions({
  registry,
  product,
  timers = realTimers,
}: ProductPermissionsDeps): ProductPermissions {
  const permissions = createSyncStore<ProductPermissionsState>('product_permissions', NONE, { equals: sameState });
  const pending = createSyncStore<PendingPermissions>('product_permissions_pending', null);

  // One listener's failure must not keep the change from the others.
  const changes = createListenerSet<PermissionsChange>({
    onListenerError: reportListener('ui', 'product_permissions.change'),
  });
  const announce = changes.emit;

  // Reads and writes run one at a time, so the store only ever moves forward.
  const work = createAsyncTaskPool({ poolSize: 1 });
  const POOL = 'product-permissions';

  function currentLabel(): string | null {
    const shown = product.get();
    return shown.status === 'loaded' ? shown.label : null;
  }

  /** A read or write lands only for the product still on show. */
  function land(label: string, next: ProductPermissionsState): void {
    if (currentLabel() === label) {
      permissions.set(next);
    }
  }

  function readStatuses(label: string): readonly PermissionStatus[] | null {
    const current = permissions.get();
    return current.status === 'read' && current.label === label ? current.statuses : null;
  }

  function patch(label: string, landed: readonly EnforceablePermissionName[], targets: PermissionTargets): void {
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
    const label = currentLabel();
    if (label === null) {
      return;
    }
    try {
      const statuses = await registry.statuses(label, NAMES);
      m.count(S.PERMISSIONS_READ, { outcome: 'ok' });
      land(label, { status: 'read', label, statuses: NAMES.map((_, i) => statuses[i] ?? 'ask') });
    } catch (error) {
      log.error('[dot.li] permissions read failed:', error);
      captureException(error, { flow: 'wallet', step: 'permissions_read' });
      m.count(S.PERMISSIONS_READ, { outcome: 'error', reason: 'read' });
      land(label, { status: 'failed', label });
    }
  }

  function reportFailure(errors: readonly unknown[]): void {
    const error = errors.length === 1 ? errors[0] : new AggregateError(errors, 'some permissions kept their status');
    log.error('[dot.li] permissions change failed:', error);
    captureException(error, { flow: 'wallet', step: 'permissions_change', tags: { reason: 'write' } });
    m.count(S.PERMISSIONS_CHANGE, { outcome: 'error', reason: 'write' });
  }

  /** Runs in the pool's slot. Writes every target, retries the failed, then shows and announces what landed. */
  async function write(label: string, targets: PermissionTargets, options: WriteOptions): Promise<WriteResult> {
    if (options.superseded?.aborted === true) {
      return { failed: [], errors: [] };
    }
    if (options.prompt !== undefined) {
      throwIfAborted(options.prompt);
    }
    const names = NAMES.filter(name => targets[name] !== undefined);
    const before = readStatuses(label);
    const was = (name: EnforceablePermissionName): PermissionStatus | undefined =>
      before === null ? undefined : permissionStatusIn(before, name);
    // With the statuses unread nothing is known to match, so every target is written.
    if (options.always !== true && before !== null && names.every(name => was(name) === targets[name])) {
      return { failed: [], errors: [] };
    }

    let failed = names;
    let errors: unknown[] = [];
    let sending: Promise<void> = Promise.resolve();
    const send = async (): Promise<void> => {
      const results = await Promise.allSettled(
        failed.map(name => registry.setStatus(label, name, targets[name] ?? 'ask')),
      );
      errors = results.flatMap((result): unknown[] => (result.status === 'rejected' ? [result.reason] : []));
      failed = failed.filter((_, i) => results[i]?.status === 'rejected');
    };
    const attempt = async (): Promise<void> => {
      sending = send();
      await sending;
      if (failed.length > 0) {
        throw new AggregateError(errors, 'some permissions kept their status');
      }
    };
    const attempts = createAsyncTaskPool({
      poolSize: 1,
      retryCount: ATTEMPTS - 1,
      retryDelay: RETRY_DELAY_MS,
      timers,
    });
    const signals = [options.superseded, options.prompt].filter(signal => signal !== undefined);
    const stop = signals.length > 0 ? AbortSignal.any(signals) : undefined;
    // `failed` and `errors` carry the outcome, so the rejection, the last attempt's or a stop's, adds nothing.
    await attempts.call(attempt, stop === undefined ? {} : { signal: stop }).then(
      () => undefined,
      () => undefined,
    );
    // A stop settles the call at once, but the writes already sent finish first.
    await sending;
    if (options.prompt !== undefined) {
      throwIfAborted(options.prompt);
    }

    const landed = names.filter(name => !failed.includes(name));
    patch(label, landed, targets);
    const changed = landed.filter(name => was(name) !== targets[name]);
    if (changed.length > 0) {
      announce({
        label,
        permissions: changed,
        allowChanged: changed.some(
          name => isDevicePermission(name) && (was(name) === 'granted' || targets[name] === 'granted'),
        ),
        fromPrompt: options.fromPrompt,
      });
    }
    if (failed.length > 0) {
      reportFailure(errors);
      // The store shows what the core kept, not what was asked for.
      await read();
    } else {
      m.count(S.PERMISSIONS_CHANGE, { outcome: 'ok' });
    }
    return { failed, errors };
  }

  let requested = 0;
  let covered = 0;

  const refresh = (): Promise<void> => {
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
  };

  // The latest panel change, which any newer one supersedes.
  let latest: AbortController | null = null;

  const change: ProductPermissions['change'] = (label, targets) => {
    latest?.abort();
    const own = new AbortController();
    latest = own;
    pending.set({ label, targets });
    return work.call(
      async () => {
        try {
          const { failed } = await write(label, targets, { superseded: own.signal, fromPrompt: false });
          return { failed };
        } finally {
          if (latest === own) {
            latest = null;
            pending.set(null);
          }
        }
      },
      { pool: POOL },
    );
  };

  const recordPromptDecision: ProductPermissions['recordPromptDecision'] = (label, name, decision, signal) =>
    work.call(
      async () => {
        if (decision === 'granted-once') {
          throwIfAborted(signal);
          const before = readStatuses(label);
          // The core holds a one-time grant for this execution only, so only a read shows it.
          await read();
          const after = readStatuses(label);
          if (
            before === null ||
            after === null ||
            permissionStatusIn(before, name) !== permissionStatusIn(after, name)
          ) {
            // A one-time grant is offered only where the iframe does not gate, so the frame stays.
            announce({ label, permissions: [name], allowChanged: false, fromPrompt: true });
          }
          return;
        }
        const { errors } = await write(label, { [name]: decision }, { prompt: signal, always: true, fromPrompt: true });
        if (errors.length > 0) {
          throw errors.length === 1 && errors[0] instanceof Error
            ? errors[0]
            : new AggregateError(errors, 'the prompt answer was not stored');
        }
      },
      { pool: POOL },
    );

  let stopFollowing: (() => void) | null = null;

  const start = (): (() => void) => {
    if (stopFollowing !== null) {
      return stopFollowing;
    }
    const follow = (): void => {
      const label = currentLabel();
      const current = permissions.get();
      if (label === null) {
        permissions.set(NONE);
        return;
      }
      if (current.status === 'none' || current.label !== label) {
        permissions.set({ status: 'reading', label });
      }
      void refresh();
    };
    follow();
    const unsubscribe = product.subscribe(follow);
    stopFollowing = () => {
      unsubscribe();
      stopFollowing = null;
    };
    return stopFollowing;
  };

  return {
    state: permissions,
    pending,
    onChanged: changes.subscribe,
    refresh,
    change,
    recordPromptDecision,
    start,
  };
}
