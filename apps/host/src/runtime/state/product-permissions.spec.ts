// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink } from '@dotli/metrics';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import type { PermissionAuthorizationRequest, PermissionAuthorizationStatus } from '@parity/truapi-host';
import { ALL_PERMISSIONS, createPermissionAuthorizations, type PermissionAuthorizations } from '../permissions.js';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { productStore, setProductError, setProductLoaded } from './product.js';
import { createProductPermissions, type PermissionsChange, type ProductPermissions } from './product-permissions.js';

const captures = { exception: vi.fn(), expected: vi.fn() };
bindCaptureSink(captures);

const LABEL = 'myapp';

function nameOf(request: PermissionAuthorizationRequest): string {
  switch (request.tag) {
    case 'Device':
      return request.value;
    case 'Remote':
      return request.value.permission.tag;
    case 'IdentityDisclosure':
    case 'AccountAccess':
      return request.tag;
  }
}

/** Statuses in menu order, every one Ask but those given. */
function statuses(given: Record<string, 'ask' | 'granted' | 'denied'> = {}): string[] {
  return ALL_PERMISSIONS.map(({ name }) => given[name] ?? 'ask');
}

interface FakeCore {
  stored: Map<string, PermissionAuthorizationStatus>;
  reads: number;
  writes: { name: string; status: PermissionAuthorizationStatus }[];
  /** Set to hold every read until the test answers it. */
  holdReads: boolean;
  heldReads: (() => void)[];
  failWrite: (name: string) => Error | null;
  /** Set to hold every write until it resolves. */
  writeGate: Promise<void> | null;
  /** Resolves at the next read the core is asked for, with what the core held when asked. */
  nextRead: () => Promise<ReadonlyMap<string, PermissionAuthorizationStatus>>;
}

const cleanups: (() => void)[] = [];

// Each test builds its own registry and store, so no registration or read carries over.
let registry: PermissionAuthorizations;
let permissions: ProductPermissions;

function fakeCore(label = LABEL, initial: Record<string, PermissionAuthorizationStatus> = {}): FakeCore {
  const readWaiters: ((held: ReadonlyMap<string, PermissionAuthorizationStatus>) => void)[] = [];
  const core: FakeCore = {
    stored: new Map(Object.entries(initial)),
    reads: 0,
    writes: [],
    holdReads: false,
    heldReads: [],
    failWrite: () => null,
    writeGate: null,
    nextRead: () =>
      new Promise(resolve => {
        readWaiters.push(resolve);
      }),
  };
  cleanups.push(
    registry.register(label, {
      getPermissionAuthorizationStatuses: requests => {
        core.reads += 1;
        for (const woken of readWaiters.splice(0)) {
          woken(new Map(core.stored));
        }
        // A snapshot taken now, as the core would answer for the moment it was asked.
        const answer = requests.map(request => core.stored.get(nameOf(request)) ?? 'NotDetermined');
        if (!core.holdReads) {
          return Promise.resolve(answer);
        }
        return new Promise(resolve => {
          core.heldReads.push(() => {
            resolve(answer);
          });
        });
      },
      setPermissionAuthorizationStatus: (request, status) => {
        const failure = core.failWrite(nameOf(request));
        if (failure !== null) {
          return Promise.reject(failure);
        }
        const store = (): void => {
          core.writes.push({ name: nameOf(request), status });
          core.stored.set(nameOf(request), status);
        };
        if (core.writeGate === null) {
          store();
          return Promise.resolve();
        }
        return core.writeGate.then(store);
      },
    }),
  );
  return core;
}

function recordChanges(): PermissionsChange[] {
  const changes: PermissionsChange[] = [];
  cleanups.push(
    permissions.onChanged(change => {
      changes.push(change);
    }),
  );
  return changes;
}

async function loaded(label = LABEL): Promise<void> {
  setProductLoaded(label, `${label}.dot`);
  await permissions.refresh();
}

beforeEach(() => {
  captures.exception.mockClear();
  registry = createPermissionAuthorizations();
  permissions = createProductPermissions({ registry, product: productStore });
  cleanups.push(permissions.start());
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
  resetAllStoresForTests();
});

describe('product permissions store', () => {
  it('As the permissions menu, I get the statuses of the product on show, read again on each load of it', async () => {
    // Given
    const core = fakeCore(LABEL, { Camera: 'Authorized', ChainSubmit: 'Denied' });

    // When
    await loaded();

    // Then
    expect(permissions.state.get()).toEqual({
      status: 'read',
      label: LABEL,
      statuses: statuses({ Camera: 'granted', ChainSubmit: 'denied' }),
    });
    const readsAfterLoad = core.reads;
    const readAgain = core.nextRead();

    // When the same product loads again
    setProductLoaded(LABEL, `${LABEL}.dot`);

    // Then
    await readAgain;
    expect(core.reads).toBe(readsAfterLoad + 1);
  });

  it('As the permissions menu, a failed load leaves no statuses to show', async () => {
    // Given
    fakeCore();
    await loaded();

    // When
    setProductError();

    // Then
    expect(permissions.state.get()).toEqual({ status: 'none' });
  });

  it("As the permissions menu, the previous product's statuses never land for the next one", async () => {
    // Given
    const first = fakeCore('first', { Camera: 'Authorized' });
    fakeCore('second');
    first.holdReads = true;
    setProductLoaded('first', 'first.dot');

    // When the product changes before the first read answers
    setProductLoaded('second', 'second.dot');
    for (const answer of first.heldReads.splice(0)) {
      answer();
    }
    await permissions.refresh();

    // Then
    expect(permissions.state.get()).toEqual({ status: 'read', label: 'second', statuses: statuses() });
  });

  it('As the permissions menu, refreshes asked for while a read runs share one later read', async () => {
    // Given
    const core = fakeCore();
    await loaded();
    const readsBefore = core.reads;
    core.holdReads = true;
    const running = permissions.refresh();
    expect(core.heldReads).toHaveLength(1);

    // When
    const queued = [permissions.refresh(), permissions.refresh(), permissions.refresh()];
    core.holdReads = false;
    for (const answer of core.heldReads.splice(0)) {
      answer();
    }
    await Promise.all([running, ...queued]);

    // Then
    expect(core.reads).toBe(readsBefore + 2);
  });

  it('As the permissions menu, a refresh keeps the last statuses showing until its read lands', async () => {
    // Given: Camera read as allowed, then denied in another tab, and a refresh whose read is held
    const core = fakeCore(LABEL, { Camera: 'Authorized' });
    await loaded();
    core.stored.set('Camera', 'Denied');
    core.holdReads = true;
    const refreshing = permissions.refresh();
    expect(core.heldReads).toHaveLength(1);

    // Then
    expect(permissions.state.get()).toEqual({
      status: 'read',
      label: LABEL,
      statuses: statuses({ Camera: 'granted' }),
    });

    // When
    for (const answer of core.heldReads.splice(0)) {
      answer();
    }
    await refreshing;

    // Then
    expect(permissions.state.get()).toEqual({
      status: 'read',
      label: LABEL,
      statuses: statuses({ Camera: 'denied' }),
    });
  });

  it('As the permissions menu, a read that cannot reach the core is reported and leaves the product without statuses', async () => {
    // Given
    cleanups.push(
      registry.register(LABEL, {
        getPermissionAuthorizationStatuses: () => Promise.reject(new Error('core down')),
        setPermissionAuthorizationStatus: () => Promise.resolve(),
      }),
    );

    // When
    await loaded();

    // Then
    expect(permissions.state.get()).toEqual({ status: 'failed', label: LABEL });
    expect(captures.exception).toHaveBeenCalledWith(new Error('core down'), {
      flow: 'wallet',
      step: 'permissions_read',
    });
  });

  it('As a user, choosing a status stores it, shows it and announces whether the app must reload', async () => {
    // Given
    const core = fakeCore();
    const changes = recordChanges();
    await loaded();

    // When
    await permissions.choose(LABEL, 'Notifications', 'granted');
    await permissions.choose(LABEL, 'Camera', 'denied');

    // Then
    expect(core.writes).toEqual([
      { name: 'Notifications', status: 'Authorized' },
      { name: 'Camera', status: 'Denied' },
    ]);
    expect(permissions.state.get()).toEqual({
      status: 'read',
      label: LABEL,
      statuses: statuses({ Notifications: 'granted', Camera: 'denied' }),
    });
    expect(changes).toEqual([
      { label: LABEL, permissions: ['Notifications'], device: false, fromPrompt: false },
      { label: LABEL, permissions: ['Camera'], device: true, fromPrompt: false },
    ]);
  });

  it('As a user, my choice still reaches the other listeners when one throws, and the failure is reported', async () => {
    // Given a listener that throws ahead of one that records
    fakeCore();
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    cleanups.push(
      permissions.onChanged(() => {
        throw new TypeError('listener broke');
      }),
    );
    const changes = recordChanges();
    await loaded();

    // When
    await permissions.choose(LABEL, 'Notifications', 'granted');

    // Then
    expect(changes).toHaveLength(1);
    expect(captures.exception).toHaveBeenCalledWith(
      expect.any(TypeError),
      expect.objectContaining({ step: 'listener', tags: { owner: 'product_permissions.change' } }),
    );
    expect(sentry.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'TypeError', owner: 'product_permissions.change' },
    ]);
  });

  it('As a user, choosing the status a permission already has writes nothing and announces nothing', async () => {
    // Given
    const core = fakeCore(LABEL, { Camera: 'Authorized' });
    const changes = recordChanges();
    await loaded();

    // When
    await permissions.choose(LABEL, 'Camera', 'granted');

    // Then
    expect(core.writes).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('As a user whose change the core refuses, the failure is reported and the menu shows what the core kept', async () => {
    // Given
    const core = fakeCore(LABEL, { Camera: 'Authorized' });
    core.failWrite = name => (name === 'Camera' ? new Error('core down') : null);
    const changes = recordChanges();
    await loaded();
    const readsBefore = core.reads;

    // When
    await permissions.choose(LABEL, 'Camera', 'denied');

    // Then
    expect(captures.exception).toHaveBeenCalledWith(new Error('core down'), {
      flow: 'wallet',
      step: 'permissions_change',
      tags: { reason: 'choose' },
    });
    expect(core.reads).toBe(readsBefore + 1);
    expect(permissions.state.get()).toEqual({
      status: 'read',
      label: LABEL,
      statuses: statuses({ Camera: 'granted' }),
    });
    expect(changes).toEqual([]);
  });

  it('As a user, Reset all to Ask announces what it reset as one change, and reports one it could not', async () => {
    // Given
    const core = fakeCore(LABEL, { Camera: 'Authorized', Microphone: 'Authorized', ChainSubmit: 'Denied' });
    core.failWrite = name => (name === 'Camera' ? new Error('core down') : null);
    const changes = recordChanges();
    await loaded();

    // When
    await permissions.reset(LABEL);

    // Then
    expect(changes).toEqual([
      { label: LABEL, permissions: ['Microphone', 'ChainSubmit'], device: true, fromPrompt: false },
    ]);
    expect(permissions.state.get()).toEqual({
      status: 'read',
      label: LABEL,
      statuses: statuses({ Camera: 'granted' }),
    });
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception.mock.calls[0]?.[1]).toEqual({
      flow: 'wallet',
      step: 'permissions_change',
      tags: { reason: 'reset_all' },
    });
  });

  it('As a user pressing Reset all twice, the second finds nothing left and announces nothing', async () => {
    // Given
    const core = fakeCore(LABEL, { Camera: 'Authorized' });
    const changes = recordChanges();
    await loaded();

    // When
    await Promise.all([permissions.reset(LABEL), permissions.reset(LABEL)]);

    // Then
    expect(core.writes).toEqual([{ name: 'Camera', status: 'NotDetermined' }]);
    expect(changes).toHaveLength(1);
  });

  it("As a product, my prompt's grant is stored, shown and announced as answering my prompt", async () => {
    // Given
    fakeCore();
    const changes = recordChanges();
    await loaded();

    // When
    await permissions.recordPromptDecision(LABEL, 'Camera', 'granted', new AbortController().signal);
    await permissions.recordPromptDecision(LABEL, 'ChainSubmit', 'granted', new AbortController().signal);

    // Then
    expect(permissions.state.get()).toEqual({
      status: 'read',
      label: LABEL,
      statuses: statuses({ Camera: 'granted', ChainSubmit: 'granted' }),
    });
    expect(changes).toEqual([
      { label: LABEL, permissions: ['Camera'], device: true, fromPrompt: true },
      { label: LABEL, permissions: ['ChainSubmit'], device: false, fromPrompt: true },
    ]);
  });

  it("As a product, my prompt's denial is stored and needs no reload, so nothing is announced", async () => {
    // Given
    const core = fakeCore();
    const changes = recordChanges();
    await loaded();

    // When
    await permissions.recordPromptDecision(LABEL, 'Camera', 'denied', new AbortController().signal);

    // Then
    expect(core.writes).toEqual([{ name: 'Camera', status: 'Denied' }]);
    expect(changes).toEqual([]);
  });

  it('As a product whose prompt answer the core cannot store, I get the failure and nothing changes', async () => {
    // Given
    const core = fakeCore();
    core.failWrite = () => new Error('core down');
    const changes = recordChanges();
    await loaded();

    // When
    const decision = permissions.recordPromptDecision(LABEL, 'Camera', 'granted', new AbortController().signal);

    // Then
    await expect(decision).rejects.toThrow('core down');
    expect(permissions.state.get()).toEqual({ status: 'read', label: LABEL, statuses: statuses() });
    expect(changes).toEqual([]);
  });

  it('As a product whose prompt was torn down while its answer was stored, nothing is announced', async () => {
    // Given
    fakeCore();
    const changes = recordChanges();
    await loaded();
    const prompt = new AbortController();

    // When
    const decision = permissions.recordPromptDecision(LABEL, 'Camera', 'granted', prompt.signal);
    prompt.abort(new DOMException('Blocking modal scope disposed', 'AbortError'));

    // Then
    await expect(decision).rejects.toThrow('Blocking modal scope disposed');
    expect(changes).toEqual([]);
  });

  it('As a product whose prompt was torn down mid-write, a refresh waits for the write to settle before it reads', async () => {
    // Given: a prompt's write held in the core, and the prompt torn down
    const core = fakeCore();
    await loaded();
    const write = Promise.withResolvers<undefined>();
    core.writeGate = write.promise;
    const prompt = new AbortController();
    const decision = permissions.recordPromptDecision(LABEL, 'Camera', 'granted', prompt.signal);
    decision.catch(() => undefined);
    prompt.abort(new DOMException('Blocking modal scope disposed', 'AbortError'));
    const readsBefore = core.reads;
    const refreshRead = core.nextRead();
    const refresh = permissions.refresh();

    // When
    write.resolve(undefined);

    // Then: the refresh reads once, and the core already holds the written grant when it does
    expect((await refreshRead).get('Camera')).toBe('Authorized');
    await expect(decision).rejects.toThrow('Blocking modal scope disposed');
    await refresh;
    expect(core.reads).toBe(readsBefore + 1);
    expect(permissions.state.get()).toMatchObject({ statuses: statuses({ Camera: 'granted' }) });
  });

  it('As the shell, starting the store again hands back the one already following the product', () => {
    // Given
    const running = permissions.start();

    // When
    const again = permissions.start();

    // Then
    expect(again).toBe(running);
  });
});

describe('product permissions store, as the permissions popover reads it', () => {
  it("As a user, when the app changes while the popover is open, the previous app's statuses are never shown for it", async () => {
    // Given
    fakeCore('first', { Camera: 'Authorized' });
    fakeCore('other');
    setProductLoaded('first', 'first.dot');
    await permissions.refresh();
    expect(permissions.state.get()).toEqual({
      status: 'read',
      label: 'first',
      statuses: statuses({ Camera: 'granted' }),
    });

    // When
    setProductLoaded('other', 'other.dot');

    // Then nothing shows until the new app's read lands, then its statuses
    expect(permissions.state.get()).toEqual({ status: 'reading', label: 'other' });
    await permissions.refresh();
    expect(permissions.state.get()).toEqual({ status: 'read', label: 'other', statuses: statuses() });
  });

  it('As a user whose app has only permissions the iframe does not gate decided, Reset all to Ask applies them without a reload', async () => {
    // Given
    fakeCore('app', { Notifications: 'Authorized', ChainSubmit: 'Denied' });
    const changes: PermissionsChange[] = [];
    cleanups.push(
      permissions.onChanged(change => {
        changes.push(change);
      }),
    );
    setProductLoaded('app', 'app.dot');
    await permissions.refresh();

    // When
    await permissions.reset('app');

    // Then
    expect(changes).toEqual([
      { label: 'app', permissions: ['Notifications', 'ChainSubmit'], device: false, fromPrompt: false },
    ]);
    expect(permissions.state.get()).toEqual({ status: 'read', label: 'app', statuses: statuses() });
  });
});
