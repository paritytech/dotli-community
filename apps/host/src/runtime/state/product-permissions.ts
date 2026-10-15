// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The permissions of the product on show. The core persists them, so the store holds what was last read or written,
// and every change goes through the intents here, one at a time, so a read never lands over a newer write. The page
// builds one, over its own registry and product.

import { captureException, m, reportListener, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, createListenerSet, log, createSyncStore, type ReadableStore } from '@dotli/shared';
import {
  ALL_PERMISSIONS,
  isDevicePermission,
  type EnforceablePermissionName,
  type PermissionAuthorizations,
  type PermissionStatus,
} from '../permissions.js';
import { throwIfAborted } from '../blocking-modal-queue.js';
import type { ProductState } from './product.js';

const NAMES: readonly EnforceablePermissionName[] = ALL_PERMISSIONS.map(({ name }) => name);

/** `statuses` follow the menu order of `ALL_PERMISSIONS`. */
export type ProductPermissionsState =
  | { status: 'none' }
  | { status: 'reading'; label: string }
  | { status: 'read'; label: string; statuses: readonly PermissionStatus[] }
  | { status: 'failed'; label: string };

export interface PermissionsChange {
  label: string;
  /** In menu order. */
  permissions: readonly EnforceablePermissionName[];
  /** The product's frame must be rebuilt, as its `allow` attribute is fixed at load. */
  device: boolean;
  /** The change answers the product's own prompt, whose response has not reached the product yet. */
  fromPrompt: boolean;
}

export type PromptDecision = 'granted' | 'granted-once' | 'denied';

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

/** A closed set, so the metric's `reason` tag stays bounded. */
type ChangeFailure = 'choose' | 'reset_all';

export interface ProductPermissionsDeps {
  /** The core's permission store, reached through the connections the product frame opens. */
  registry: Pick<PermissionAuthorizations, 'statuses' | 'setStatus' | 'resetAll'>;
  /** The product on show, whose permissions the store holds. */
  product: ReadableStore<ProductState>;
}

export interface ProductPermissions {
  state: ReadableStore<ProductPermissionsState>;
  /** Every change this store makes, for whoever must act on it, such as the frame that reloads for a device one. */
  onChanged: (listener: (change: PermissionsChange) => void) => () => void;
  /** Reads the statuses again. Calls that queue behind a read share the next one. */
  refresh: () => Promise<void>;
  /** The user picks a status in the menu. Never rejects, as a failure is reported and the store re-read. */
  choose: (label: string, name: EnforceablePermissionName, next: PermissionStatus) => Promise<void>;
  /** Every decided permission back to Ask, announced as one change. Never rejects, like `choose`. */
  reset: (label: string) => Promise<void>;
  /**
   * A decision from the product's own prompt. A failed write rejects, so the product hears it, and an aborted prompt
   * changes nothing once the write is back.
   */
  recordPromptDecision: (
    label: string,
    name: EnforceablePermissionName,
    decision: PromptDecision,
    signal: AbortSignal,
  ) => Promise<void>;
  /** Reads on every load, a reload of the same product included, until the returned stop. A second call returns it too. */
  start: () => () => void;
}

export function createProductPermissions({ registry, product }: ProductPermissionsDeps): ProductPermissions {
  const permissions = createSyncStore<ProductPermissionsState>('product_permissions', NONE, { equals: sameState });

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

  function patch(label: string, changed: readonly EnforceablePermissionName[], status: PermissionStatus): void {
    const current = permissions.get();
    if (current.status !== 'read' || current.label !== label) {
      return;
    }
    land(label, {
      status: 'read',
      label,
      statuses: NAMES.map((name, i) => (changed.includes(name) ? status : (current.statuses[i] ?? 'ask'))),
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

  async function reportChangeFailure(error: unknown, reason: ChangeFailure): Promise<void> {
    log.error(`[dot.li] permissions ${reason} failed:`, error);
    captureException(error, { flow: 'wallet', step: 'permissions_change', tags: { reason } });
    m.count(S.PERMISSIONS_CHANGE, { outcome: 'error', reason });
    // The store shows what the core kept, not what was asked for.
    await read();
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

  const choose: ProductPermissions['choose'] = (label, name, next) =>
    work.call(
      async () => {
        const current = permissions.get();
        if (
          current.status === 'read' &&
          current.label === label &&
          permissionStatusIn(current.statuses, name) === next
        ) {
          return;
        }
        try {
          await registry.setStatus(label, name, next);
        } catch (error) {
          await reportChangeFailure(error, 'choose');
          return;
        }
        m.count(S.PERMISSIONS_CHANGE, { outcome: 'ok' });
        patch(label, [name], next);
        announce({ label, permissions: [name], device: isDevicePermission(name), fromPrompt: false });
      },
      { pool: POOL },
    );

  const reset: ProductPermissions['reset'] = label =>
    work.call(
      async () => {
        let result;
        try {
          result = await registry.resetAll(label);
        } catch (error) {
          await reportChangeFailure(error, 'reset_all');
          return;
        }
        const { reset: cleared, errors } = result;
        if (cleared.length > 0) {
          patch(label, cleared, 'ask');
          announce({
            label,
            permissions: cleared,
            device: cleared.some(name => isDevicePermission(name)),
            fromPrompt: false,
          });
        }
        if (errors.length > 0) {
          await reportChangeFailure(new AggregateError(errors, 'some permissions kept their status'), 'reset_all');
        } else if (cleared.length > 0) {
          m.count(S.PERMISSIONS_CHANGE, { outcome: 'ok' });
        }
      },
      { pool: POOL },
    );

  const recordPromptDecision: ProductPermissions['recordPromptDecision'] = (label, name, decision, signal) =>
    work.call(
      async () => {
        // The pool frees its slot the moment the signal aborts, so the check here keeps a queued read from running beside the write.
        throwIfAborted(signal);
        if (decision === 'granted-once') {
          // The core holds a one-time grant for this execution only, so only a read shows it.
          await read();
        } else {
          const status = decision === 'granted' ? 'granted' : 'denied';
          await registry.setStatus(label, name, status);
          throwIfAborted(signal);
          patch(label, [name], status);
        }
        if (decision !== 'denied') {
          announce({
            label,
            permissions: [name],
            device: decision === 'granted' && isDevicePermission(name),
            fromPrompt: true,
          });
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
    onChanged: changes.subscribe,
    refresh,
    choose,
    reset,
    recordPromptDecision,
    start,
  };
}
