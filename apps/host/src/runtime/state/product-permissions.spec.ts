// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink } from '@dotli/metrics';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import type { PermissionAuthorizationRequest, PermissionAuthorizationStatus } from '@parity/truapi-host';
import { ALL_PERMISSIONS, createPermissionAuthorizations, type PermissionAuthorizations } from '../permissions.js';
import { manualTimers, resetAllStoresForTests, type ManualTimers } from '@dotli/shared/testing';
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

/** A store over the same registry whose retries wait on `timers`, which the test moves. */
function permissionsOn(timers: ManualTimers): ProductPermissions {
  permissions = createProductPermissions({ registry, product: productStore, timers });
  cleanups.push(permissions.start());
  return permissions;
}

/** Every permission at `status`, as a preset move or the reset writes them. */
function all(status: 'ask' | 'granted' | 'denied'): Record<string, 'ask' | 'granted' | 'denied'> {
  return Object.fromEntries(ALL_PERMISSIONS.map(({ name }) => [name, status]));
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

  it('As a user, a change stores its targets, shows them and announces once whether the frame must be rebuilt', async () => {
    // Given
    const core = fakeCore();
    const changes = recordChanges();
    await loaded();

    // When
    await permissions.change(LABEL, { Notifications: 'granted' });
    await permissions.change(LABEL, { Camera: 'granted' });

    // Then
    expect(core.writes).toEqual([
      { name: 'Notifications', status: 'Authorized' },
      { name: 'Camera', status: 'Authorized' },
    ]);
    expect(permissions.state.get()).toEqual({
      status: 'read',
      label: LABEL,
      statuses: statuses({ Notifications: 'granted', Camera: 'granted' }),
    });
    expect(changes).toEqual([
      { label: LABEL, permissions: ['Notifications'], allowChanged: false, fromPrompt: false },
      { label: LABEL, permissions: ['Camera'], allowChanged: true, fromPrompt: false },
    ]);
  });

  it('As a user, denying a camera that was only asked for leaves the frame as it is', async () => {
    // Given
    fakeCore();
    const changes = recordChanges();
    await loaded();

    // When
    await permissions.change(LABEL, { Camera: 'denied' });

    // Then
    expect(changes).toEqual([{ label: LABEL, permissions: ['Camera'], allowChanged: false, fromPrompt: false }]);
  });

  it('As a user, my change still reaches the other listeners when one throws, and the failure is reported', async () => {
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
    await permissions.change(LABEL, { Notifications: 'granted' });

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

  it('As a user, a change whose targets all equal the statuses read writes nothing and announces nothing', async () => {
    // Given
    const core = fakeCore(LABEL, { Camera: 'Authorized' });
    const changes = recordChanges();
    await loaded();

    // When
    const outcome = await permissions.change(LABEL, { Camera: 'granted' });

    // Then
    expect(outcome).toEqual({ failed: [] });
    expect(core.writes).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('As a user moving to a preset, every target is written, and only those that changed are announced', async () => {
    // Given
    const core = fakeCore(LABEL, { Camera: 'Authorized' });
    const changes = recordChanges();
    await loaded();

    // When
    await permissions.change(LABEL, { Camera: 'granted', Microphone: 'granted', ChainSubmit: 'denied' });

    // Then
    expect(core.writes).toEqual([
      { name: 'Camera', status: 'Authorized' },
      { name: 'Microphone', status: 'Authorized' },
      { name: 'ChainSubmit', status: 'Denied' },
    ]);
    expect(changes).toEqual([
      { label: LABEL, permissions: ['Microphone', 'ChainSubmit'], allowChanged: true, fromPrompt: false },
    ]);
  });

  it('As a user moving from Restricted to Secure, twelve writes land and the frame is left as it is', async () => {
    // Given
    fakeCore(LABEL, Object.fromEntries(ALL_PERMISSIONS.map(({ name }) => [name, 'Denied'])));
    const changes = recordChanges();
    await loaded();

    // When
    await permissions.change(LABEL, all('ask'));

    // Then
    expect(permissions.state.get()).toMatchObject({ statuses: statuses() });
    expect(changes).toEqual([
      { label: LABEL, permissions: ALL_PERMISSIONS.map(({ name }) => name), allowChanged: false, fromPrompt: false },
    ]);
  });

  it('As a user, a write the core refuses once is retried after 300 ms, alone, and the change announces once', async () => {
    // Given
    const timers = manualTimers();
    permissionsOn(timers);
    const core = fakeCore();
    let refusals = 1;
    core.failWrite = name => (name === 'Camera' && refusals-- > 0 ? new Error('core busy') : null);
    const changes = recordChanges();
    await loaded();

    // When
    const outcome = permissions.change(LABEL, { Camera: 'granted', Microphone: 'granted' });
    await timers.advance(299);

    // Then
    expect(core.writes).toEqual([{ name: 'Microphone', status: 'Authorized' }]);

    // When
    await timers.advance(1);

    // Then
    await expect(outcome).resolves.toEqual({ failed: [] });
    expect(core.writes).toEqual([
      { name: 'Microphone', status: 'Authorized' },
      { name: 'Camera', status: 'Authorized' },
    ]);
    expect(changes).toEqual([
      { label: LABEL, permissions: ['Camera', 'Microphone'], allowChanged: true, fromPrompt: false },
    ]);
    expect(captures.exception).not.toHaveBeenCalled();
  });

  it('As a user whose write fails three times, the change names it, is reported once and shows what the core kept', async () => {
    // Given
    const timers = manualTimers();
    permissionsOn(timers);
    const core = fakeCore(LABEL, { Camera: 'Authorized', Microphone: 'Authorized', ChainSubmit: 'Denied' });
    let attempts = 0;
    core.failWrite = name => {
      if (name !== 'Camera') {
        return null;
      }
      attempts += 1;
      return new Error('core down');
    };
    const changes = recordChanges();
    await loaded();
    const readsBefore = core.reads;

    // When
    const outcome = permissions.change(LABEL, all('ask'));
    await timers.advance(300);
    await timers.advance(300);

    // Then
    await expect(outcome).resolves.toEqual({ failed: ['Camera'] });
    expect(attempts).toBe(3);
    expect(changes).toEqual([
      { label: LABEL, permissions: ['Microphone', 'ChainSubmit'], allowChanged: true, fromPrompt: false },
    ]);
    expect(captures.exception).toHaveBeenCalledExactlyOnceWith(new Error('core down'), {
      flow: 'wallet',
      step: 'permissions_change',
      tags: { reason: 'write' },
    });
    expect(core.reads).toBe(readsBefore + 1);
    expect(permissions.state.get()).toMatchObject({ statuses: statuses({ Camera: 'granted' }) });
  });

  it('As a user pressing Reset to Secure twice, the second finds the statuses already at Ask and writes nothing', async () => {
    // Given
    const core = fakeCore(LABEL, { Camera: 'Authorized' });
    const changes = recordChanges();
    await loaded();

    // When
    await Promise.all([permissions.change(LABEL, all('ask')), permissions.change(LABEL, all('ask'))]);

    // Then
    expect(core.writes).toHaveLength(ALL_PERMISSIONS.length);
    expect(changes).toHaveLength(1);
  });

  it('As a user, a pending change shows its targets until it settles', async () => {
    // Given
    const core = fakeCore();
    await loaded();
    const write = Promise.withResolvers<undefined>();
    core.writeGate = write.promise;

    // When
    const outcome = permissions.change(LABEL, { Camera: 'granted' });

    // Then
    expect(permissions.pending.get()).toEqual({ label: LABEL, targets: { Camera: 'granted' } });

    // When
    write.resolve(undefined);
    await outcome;

    // Then
    expect(permissions.pending.get()).toBeNull();
    expect(permissions.state.get()).toMatchObject({ statuses: statuses({ Camera: 'granted' }) });
  });

  it('As a user making three moves in a burst, the queued one is dropped and only the first and the last write', async () => {
    // Given
    const core = fakeCore();
    await loaded();
    const write = Promise.withResolvers<undefined>();
    core.writeGate = write.promise;

    // When
    const first = permissions.change(LABEL, { Camera: 'granted' });
    const dropped = permissions.change(LABEL, { Microphone: 'granted' });
    const last = permissions.change(LABEL, { Location: 'granted' });

    // Then
    expect(permissions.pending.get()).toEqual({ label: LABEL, targets: { Location: 'granted' } });

    // When
    write.resolve(undefined);

    // Then
    await expect(dropped).resolves.toEqual({ failed: [] });
    await Promise.all([first, last]);
    expect(core.writes.map(({ name }) => name)).toEqual(['Camera', 'Location']);
    expect(permissions.pending.get()).toBeNull();
  });

  it('As a user making a newer move while one waits to retry, the older one stops retrying', async () => {
    // Given
    const timers = manualTimers();
    permissionsOn(timers);
    const core = fakeCore();
    let cameraAttempts = 0;
    core.failWrite = name => {
      if (name !== 'Camera') {
        return null;
      }
      cameraAttempts += 1;
      return new Error('core down');
    };
    await loaded();
    const older = permissions.change(LABEL, { Camera: 'granted' });
    await timers.advance(0);

    // When
    const newer = permissions.change(LABEL, { Microphone: 'granted' });
    await timers.advance(600);

    // Then
    await expect(older).resolves.toEqual({ failed: ['Camera'] });
    await expect(newer).resolves.toEqual({ failed: [] });
    expect(cameraAttempts).toBe(1);
    expect(core.writes).toEqual([{ name: 'Microphone', status: 'Authorized' }]);
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
      { label: LABEL, permissions: ['Camera'], allowChanged: true, fromPrompt: true },
      { label: LABEL, permissions: ['ChainSubmit'], allowChanged: false, fromPrompt: true },
    ]);
  });

  it("As a product, my prompt's denial is stored and announced, and leaves the frame as it is", async () => {
    // Given
    const core = fakeCore();
    const changes = recordChanges();
    await loaded();

    // When
    await permissions.recordPromptDecision(LABEL, 'Camera', 'denied', new AbortController().signal);

    // Then
    expect(core.writes).toEqual([{ name: 'Camera', status: 'Denied' }]);
    expect(changes).toEqual([{ label: LABEL, permissions: ['Camera'], allowChanged: false, fromPrompt: true }]);
  });

  it('As a product whose prompt answer the core cannot store after three attempts, I get the failure, it is reported once and nothing changes', async () => {
    // Given
    const timers = manualTimers();
    permissionsOn(timers);
    const core = fakeCore();
    let attempts = 0;
    core.failWrite = () => {
      attempts += 1;
      return new Error('core down');
    };
    const changes = recordChanges();
    await loaded();

    // When
    const decision = permissions.recordPromptDecision(LABEL, 'Camera', 'granted', new AbortController().signal);
    decision.catch(() => undefined);
    await timers.advance(300);
    await timers.advance(300);

    // Then
    await expect(decision).rejects.toThrow('core down');
    expect(attempts).toBe(3);
    expect(captures.exception).toHaveBeenCalledExactlyOnceWith(new Error('core down'), {
      flow: 'wallet',
      step: 'permissions_change',
      tags: { reason: 'write' },
    });
    expect(permissions.state.get()).toEqual({ status: 'read', label: LABEL, statuses: statuses() });
    expect(changes).toEqual([]);
  });

  it('As a product whose prompt is answered Always allow while the statuses read are stale, the answer is still stored', async () => {
    // Given: Camera read as allowed, then reset to Ask behind the store's back, so the prompt asks
    const core = fakeCore(LABEL, { Camera: 'Authorized' });
    await loaded();
    core.stored.set('Camera', 'NotDetermined');

    // When
    await permissions.recordPromptDecision(LABEL, 'Camera', 'granted', new AbortController().signal);

    // Then
    expect(core.writes).toEqual([{ name: 'Camera', status: 'Authorized' }]);
    expect(core.stored.get('Camera')).toBe('Authorized');
  });

  it('As a product, my prompt decision queued between two panel changes is never superseded and still announces', async () => {
    // Given: a panel change whose write is held, and a prompt decision queued behind it
    const core = fakeCore();
    const changes = recordChanges();
    await loaded();
    const write = Promise.withResolvers<undefined>();
    core.writeGate = write.promise;
    const first = permissions.change(LABEL, { Camera: 'granted' });
    const decision = permissions.recordPromptDecision(LABEL, 'Microphone', 'granted', new AbortController().signal);

    // When a newer panel change supersedes the first
    const last = permissions.change(LABEL, { Location: 'granted' });
    write.resolve(undefined);
    await Promise.all([first, decision, last]);

    // Then
    expect(core.writes.map(({ name }) => name)).toEqual(['Camera', 'Microphone', 'Location']);
    expect(changes).toContainEqual({
      label: LABEL,
      permissions: ['Microphone'],
      allowChanged: true,
      fromPrompt: true,
    });
  });

  it('As a product whose prompt was torn down while a write waits to retry, no more attempts are made and nothing changes', async () => {
    // Given: a prompt whose first write the core refused
    const timers = manualTimers();
    permissionsOn(timers);
    const core = fakeCore();
    let attempts = 0;
    core.failWrite = () => {
      attempts += 1;
      return new Error('core busy');
    };
    const changes = recordChanges();
    await loaded();
    const prompt = new AbortController();
    const decision = permissions.recordPromptDecision(LABEL, 'Camera', 'granted', prompt.signal);
    decision.catch(() => undefined);
    await timers.advance(0);
    expect(attempts).toBe(1);

    // When
    prompt.abort(new DOMException('Blocking modal scope disposed', 'AbortError'));
    await timers.advance(600);

    // Then
    await expect(decision).rejects.toThrow('Blocking modal scope disposed');
    expect(attempts).toBe(1);
    expect(permissions.state.get()).toEqual({ status: 'read', label: LABEL, statuses: statuses() });
    expect(changes).toEqual([]);
  });

  it('As a product granted once, the grant is announced only when the read shows a change, and leaves the frame as it is', async () => {
    // Given
    const core = fakeCore();
    const changes = recordChanges();
    await loaded();
    // The core holds the one-time grant it gave for this execution.
    core.stored.set('ChainSubmit', 'Authorized');

    // When
    await permissions.recordPromptDecision(LABEL, 'ChainSubmit', 'granted-once', new AbortController().signal);

    // Then
    expect(changes).toEqual([{ label: LABEL, permissions: ['ChainSubmit'], allowChanged: false, fromPrompt: true }]);
    expect(permissions.state.get()).toMatchObject({ statuses: statuses({ ChainSubmit: 'granted' }) });

    // When granted once again, with the read showing no change
    await permissions.recordPromptDecision(LABEL, 'ChainSubmit', 'granted-once', new AbortController().signal);

    // Then
    expect(changes).toHaveLength(1);
    expect(core.writes).toEqual([]);
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
  it('As a user, a change I made for an app lands only while that app is on show', async () => {
    // Given: a change for the first app whose write is held
    const first = fakeCore(LABEL);
    const other = fakeCore('other');
    await loaded();
    const write = Promise.withResolvers<undefined>();
    first.writeGate = write.promise;
    const outcome = permissions.change(LABEL, { Camera: 'granted' });

    // When the app changes, its read held, and the write is released
    other.holdReads = true;
    setProductLoaded('other', 'other.dot');
    write.resolve(undefined);
    await outcome;

    // Then
    expect(first.stored.get('Camera')).toBe('Authorized');
    expect(permissions.state.get()).toEqual({ status: 'reading', label: 'other' });

    // When
    other.holdReads = false;
    for (const answer of other.heldReads.splice(0)) {
      answer();
    }
    await permissions.refresh();

    // Then
    expect(permissions.state.get()).toEqual({ status: 'read', label: 'other', statuses: statuses() });
  });

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
});
