// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink } from '@dotli/metrics';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import type { PermissionAuthorizationRequest, PermissionAuthorizationStatus } from '@parity/truapi-host';
import { createPermissionAuthorizations, type PermissionAuthorizations } from '../createPermissionAuthorizations.js';
import { ALL_PERMISSIONS } from '../permissionPolicy.js';
import { createManualTimers, resetAllStoresForTests, type ManualTimers } from '@dotli/shared/testing';
import { productState } from './productState.js';
import { createProductPermissions, type PermissionsChange, type ProductPermissions } from './productPermissions.js';

type FakeCore = {
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
};

const LABEL = 'myapp';

const captures = { exception: vi.fn(), expected: vi.fn() };
const cleanups: (() => void)[] = [];

// Each test builds its own registry and store, so no registration or read carries over.
let registry: PermissionAuthorizations;
let permissions: ProductPermissions;

beforeEach(() => {
  captures.exception.mockClear();
  cleanups.push(bindCaptureSink(captures));
  registry = createPermissionAuthorizations();
  permissions = createProductPermissions({ registry, product: productState.store });
  cleanups.push(permissions.start());
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
  resetAllStoresForTests();
});

describe('product permissions store', () => {
  it('As a user on the permissions menu, I load a product and see its statuses', async () => {
    // Given
    createFakeCore(LABEL, { Camera: 'Authorized', ChainSubmit: 'Denied' });

    // When
    await loadProduct();

    // Then
    expect(permissions.state.get()).toEqual({
      status: 'read',
      label: LABEL,
      statuses: buildStatuses({ Camera: 'granted', ChainSubmit: 'denied' }),
    });
  });

  it('As a user on the permissions menu, I reload the product on show and its statuses are read again', async () => {
    // Given
    const core = createFakeCore();
    await loadProduct();
    const readsAfterLoad = core.reads;
    const readAgain = core.nextRead();

    // When the same product loads again
    productState.setLoaded({ label: LABEL, productId: `${LABEL}.dot` });
    await readAgain;

    // Then
    expect(core.reads).toBe(readsAfterLoad + 1);
  });

  it('As a user on the permissions menu, I hit a failed load and see no statuses', async () => {
    // Given
    createFakeCore();
    await loadProduct();

    // When
    productState.setError();

    // Then
    expect(permissions.state.get()).toEqual({ status: 'none' });
  });

  it("As a user on the permissions menu, I switch products before a read answers and never see the previous product's statuses", async () => {
    // Given
    const first = createFakeCore('first', { Camera: 'Authorized' });
    createFakeCore('second');
    first.holdReads = true;
    productState.setLoaded({ label: 'first', productId: 'first.dot' });

    // When the product changes before the first read answers
    productState.setLoaded({ label: 'second', productId: 'second.dot' });
    for (const answer of first.heldReads.splice(0)) {
      answer();
    }
    await permissions.refresh();

    // Then
    expect(permissions.state.get()).toEqual({ status: 'read', label: 'second', statuses: buildStatuses() });
  });

  it('As a user on the permissions menu, I ask for refreshes while a read runs and they share one later read', async () => {
    // Given
    const core = createFakeCore();
    await loadProduct();
    const readsBefore = core.reads;
    core.holdReads = true;
    const running = permissions.refresh();

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

  it('As a user on the permissions menu, I refresh and keep seeing the last statuses until the read lands', async () => {
    // Given: Camera read as allowed, then denied in another tab, and every read held
    const core = createFakeCore(LABEL, { Camera: 'Authorized' });
    await loadProduct();
    core.stored.set('Camera', 'Denied');
    core.holdReads = true;

    // When
    const refreshing = permissions.refresh();

    // Then
    expect(permissions.state.get()).toEqual({
      status: 'read',
      label: LABEL,
      statuses: buildStatuses({ Camera: 'granted' }),
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
      statuses: buildStatuses({ Camera: 'denied' }),
    });
  });

  it('As a user on the permissions menu, I load a product whose core cannot be reached and see no statuses while the failure is reported', async () => {
    // Given
    cleanups.push(
      registry.register(LABEL, {
        getPermissionAuthorizationStatuses: () => Promise.reject(new Error('core down')),
        setPermissionAuthorizationStatus: () => Promise.resolve(),
      }),
    );

    // When
    await loadProduct();

    // Then
    expect(permissions.state.get()).toEqual({ status: 'failed', label: LABEL });
    expect(captures.exception).toHaveBeenCalledWith(new Error('core down'), {
      flow: 'wallet',
      step: 'permissions_read',
    });
  });

  it('As a user, I make a change and see its targets stored, shown and announced once with whether the frame must be rebuilt', async () => {
    // Given
    const core = createFakeCore();
    const changes = recordChanges();
    await loadProduct();

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
      statuses: buildStatuses({ Notifications: 'granted', Camera: 'granted' }),
    });
    expect(changes).toEqual([
      { label: LABEL, permissions: ['Notifications'], allowChanged: false, fromPrompt: false },
      { label: LABEL, permissions: ['Camera'], allowChanged: true, fromPrompt: false },
    ]);
  });

  it('As a user, I deny a camera that was only asked for and the frame is left as it is', async () => {
    // Given
    createFakeCore();
    const changes = recordChanges();
    await loadProduct();

    // When
    await permissions.change(LABEL, { Camera: 'denied' });

    // Then
    expect(changes).toEqual([{ label: LABEL, permissions: ['Camera'], allowChanged: false, fromPrompt: false }]);
  });

  it('As a user, I make a change while one listener throws and the others still hear it and the failure is reported', async () => {
    // Given a listener that throws ahead of one that records
    createFakeCore();
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    cleanups.push(
      permissions.subscribeChanges(() => {
        throw new TypeError('listener broke');
      }),
    );
    const changes = recordChanges();
    await loadProduct();

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

  it('As a user, I make a change whose targets all equal the statuses read and nothing is written or announced', async () => {
    // Given
    const core = createFakeCore(LABEL, { Camera: 'Authorized' });
    const changes = recordChanges();
    await loadProduct();

    // When
    const outcome = await permissions.change(LABEL, { Camera: 'granted' });

    // Then
    expect(outcome).toEqual({ failed: [] });
    expect(core.writes).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('As a user, I move to a preset and every target is written while only those that changed are announced', async () => {
    // Given
    const core = createFakeCore(LABEL, { Camera: 'Authorized' });
    const changes = recordChanges();
    await loadProduct();

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

  it('As a user, I move from Restricted to Secure and twelve writes land while the frame is left as it is', async () => {
    // Given
    createFakeCore(LABEL, Object.fromEntries(ALL_PERMISSIONS.map(({ name }) => [name, 'Denied'])));
    const changes = recordChanges();
    await loadProduct();

    // When
    await permissions.change(LABEL, buildAllTargets('ask'));

    // Then
    expect(permissions.state.get()).toMatchObject({ statuses: buildStatuses() });
    expect(changes).toEqual([
      { label: LABEL, permissions: ALL_PERMISSIONS.map(({ name }) => name), allowChanged: false, fromPrompt: false },
    ]);
  });

  it('As a user, I make a change the core refuses once and the write is retried alone after 300 ms and announced once', async () => {
    // Given
    const timers = createManualTimers();
    startPermissions(timers);
    const core = createFakeCore();
    let refusals = 1;
    core.failWrite = name => (name === 'Camera' && refusals-- > 0 ? new Error('core busy') : null);
    const changes = recordChanges();
    await loadProduct();

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

  it('As a user, I make a change whose write fails three times and it names the write, is reported once and shows what the core kept', async () => {
    // Given
    const timers = createManualTimers();
    startPermissions(timers);
    const core = createFakeCore(LABEL, { Camera: 'Authorized', Microphone: 'Authorized', ChainSubmit: 'Denied' });
    let attempts = 0;
    core.failWrite = name => {
      if (name !== 'Camera') {
        return null;
      }
      attempts += 1;
      return new Error('core down');
    };
    const changes = recordChanges();
    await loadProduct();
    const readsBefore = core.reads;

    // When
    const outcome = permissions.change(LABEL, buildAllTargets('ask'));
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
    expect(permissions.state.get()).toMatchObject({ statuses: buildStatuses({ Camera: 'granted' }) });
  });

  it('As a user, I press Reset to Secure twice and the second finds the statuses already at Ask and writes nothing', async () => {
    // Given
    const core = createFakeCore(LABEL, { Camera: 'Authorized' });
    const changes = recordChanges();
    await loadProduct();

    // When
    await Promise.all([
      permissions.change(LABEL, buildAllTargets('ask')),
      permissions.change(LABEL, buildAllTargets('ask')),
    ]);

    // Then
    expect(core.writes).toHaveLength(ALL_PERMISSIONS.length);
    expect(changes).toHaveLength(1);
  });

  it('As a user, I make a change and see its targets pending until it settles', async () => {
    // Given
    const core = createFakeCore();
    await loadProduct();
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
    expect(permissions.state.get()).toMatchObject({ statuses: buildStatuses({ Camera: 'granted' }) });
  });

  it('As a user, I make three moves in a burst and the queued one is dropped while only the first and the last write', async () => {
    // Given
    const core = createFakeCore();
    await loadProduct();
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
    const [, droppedOutcome] = await Promise.all([first, dropped, last]);

    // Then
    expect(droppedOutcome).toEqual({ failed: [] });
    expect(core.writes.map(({ name }) => name)).toEqual(['Camera', 'Location']);
    expect(permissions.pending.get()).toBeNull();
  });

  it('As a user, I make a newer move while one waits to retry and the older one stops retrying', async () => {
    // Given
    const timers = createManualTimers();
    startPermissions(timers);
    const core = createFakeCore();
    let cameraAttempts = 0;
    core.failWrite = name => {
      if (name !== 'Camera') {
        return null;
      }
      cameraAttempts += 1;
      return new Error('core down');
    };
    await loadProduct();
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

  it("As a user, I grant a product's prompts and each grant is stored, shown and announced as a prompt answer", async () => {
    // Given
    createFakeCore();
    const changes = recordChanges();
    await loadProduct();

    // When
    await permissions.recordPromptDecision({
      label: LABEL,
      name: 'Camera',
      decision: 'granted',
      signal: new AbortController().signal,
    });
    await permissions.recordPromptDecision({
      label: LABEL,
      name: 'ChainSubmit',
      decision: 'granted',
      signal: new AbortController().signal,
    });

    // Then
    expect(permissions.state.get()).toEqual({
      status: 'read',
      label: LABEL,
      statuses: buildStatuses({ Camera: 'granted', ChainSubmit: 'granted' }),
    });
    expect(changes).toEqual([
      { label: LABEL, permissions: ['Camera'], allowChanged: true, fromPrompt: true },
      { label: LABEL, permissions: ['ChainSubmit'], allowChanged: false, fromPrompt: true },
    ]);
  });

  it("As a user, I deny a product's prompt and the denial is stored and announced while the frame is left as it is", async () => {
    // Given
    const core = createFakeCore();
    const changes = recordChanges();
    await loadProduct();

    // When
    await permissions.recordPromptDecision({
      label: LABEL,
      name: 'Camera',
      decision: 'denied',
      signal: new AbortController().signal,
    });

    // Then
    expect(core.writes).toEqual([{ name: 'Camera', status: 'Denied' }]);
    expect(changes).toEqual([{ label: LABEL, permissions: ['Camera'], allowChanged: false, fromPrompt: true }]);
  });

  it("As a user, I answer a product's prompt the core cannot store after three attempts and the answer fails, is reported once and changes nothing", async () => {
    // Given
    const timers = createManualTimers();
    startPermissions(timers);
    const core = createFakeCore();
    let attempts = 0;
    core.failWrite = () => {
      attempts += 1;
      return new Error('core down');
    };
    const changes = recordChanges();
    await loadProduct();

    // When
    const decision = permissions.recordPromptDecision({
      label: LABEL,
      name: 'Camera',
      decision: 'granted',
      signal: new AbortController().signal,
    });
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
    expect(permissions.state.get()).toEqual({ status: 'read', label: LABEL, statuses: buildStatuses() });
    expect(changes).toEqual([]);
  });

  it("As a user, I answer a product's prompt Always allow while the statuses read are stale and the answer is still stored", async () => {
    // Given: Camera read as allowed, then reset to Ask behind the store's back, so the prompt asks
    const core = createFakeCore(LABEL, { Camera: 'Authorized' });
    await loadProduct();
    core.stored.set('Camera', 'NotDetermined');

    // When
    await permissions.recordPromptDecision({
      label: LABEL,
      name: 'Camera',
      decision: 'granted',
      signal: new AbortController().signal,
    });

    // Then
    expect(core.writes).toEqual([{ name: 'Camera', status: 'Authorized' }]);
    expect(core.stored.get('Camera')).toBe('Authorized');
  });

  it("As a user, I answer a product's prompt queued between two panel changes and the answer is never superseded and still announces", async () => {
    // Given: a panel change whose write is held, and a prompt decision queued behind it
    const core = createFakeCore();
    const changes = recordChanges();
    await loadProduct();
    const write = Promise.withResolvers<undefined>();
    core.writeGate = write.promise;
    const first = permissions.change(LABEL, { Camera: 'granted' });
    const decision = permissions.recordPromptDecision({
      label: LABEL,
      name: 'Microphone',
      decision: 'granted',
      signal: new AbortController().signal,
    });

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

  it("As a user, I close a product's prompt while its write waits to retry and no more attempts are made and nothing changes", async () => {
    // Given: a prompt whose first write the core refused
    const timers = createManualTimers();
    startPermissions(timers);
    const core = createFakeCore();
    let attempts = 0;
    core.failWrite = () => {
      attempts += 1;
      return new Error('core busy');
    };
    const changes = recordChanges();
    await loadProduct();
    const prompt = new AbortController();
    const decision = permissions.recordPromptDecision({
      label: LABEL,
      name: 'Camera',
      decision: 'granted',
      signal: prompt.signal,
    });
    decision.catch(() => undefined);
    await timers.advance(0);

    // When
    prompt.abort(new DOMException('Blocking modal scope disposed', 'AbortError'));
    await timers.advance(600);

    // Then
    await expect(decision).rejects.toThrow('Blocking modal scope disposed');
    expect(attempts).toBe(1);
    expect(permissions.state.get()).toEqual({ status: 'read', label: LABEL, statuses: buildStatuses() });
    expect(changes).toEqual([]);
  });

  it("As a user, I close a product's prompt while its answer is stored and nothing is announced", async () => {
    // Given
    createFakeCore();
    const changes = recordChanges();
    await loadProduct();
    const prompt = new AbortController();

    // When
    const decision = permissions.recordPromptDecision({
      label: LABEL,
      name: 'Camera',
      decision: 'granted',
      signal: prompt.signal,
    });
    prompt.abort(new DOMException('Blocking modal scope disposed', 'AbortError'));

    // Then
    await expect(decision).rejects.toThrow('Blocking modal scope disposed');
    expect(changes).toEqual([]);
  });

  it("As a user, I close a product's prompt mid-write and a refresh waits for the write to settle before it reads", async () => {
    // Given: a prompt's write held in the core, the prompt torn down, and a refresh asked for
    const core = createFakeCore();
    await loadProduct();
    const write = Promise.withResolvers<undefined>();
    core.writeGate = write.promise;
    const prompt = new AbortController();
    const decision = permissions.recordPromptDecision({
      label: LABEL,
      name: 'Camera',
      decision: 'granted',
      signal: prompt.signal,
    });
    decision.catch(() => undefined);
    prompt.abort(new DOMException('Blocking modal scope disposed', 'AbortError'));
    const readsBefore = core.reads;
    const refreshRead = core.nextRead();
    const refresh = permissions.refresh();

    // When
    write.resolve(undefined);
    const heldAtRead = await refreshRead;
    await refresh;

    // Then: the refresh reads once, and the core already holds the written grant when it does
    expect(heldAtRead.get('Camera')).toBe('Authorized');
    await expect(decision).rejects.toThrow('Blocking modal scope disposed');
    expect(core.reads).toBe(readsBefore + 1);
    expect(permissions.state.get()).toMatchObject({ statuses: buildStatuses({ Camera: 'granted' }) });
  });

  it('As a dotli integrator, I start the store again and get back the one already following the product', () => {
    // Given
    const running = permissions.start();

    // When
    const again = permissions.start();

    // Then
    expect(again).toBe(running);
  });
});

describe('product permissions store, as the permissions popover reads it', () => {
  it('As a user, I make a change for an app and it lands only while that app is on show', async () => {
    // Given: a change for the first app whose write is held
    const first = createFakeCore(LABEL);
    const other = createFakeCore('other');
    await loadProduct();
    const write = Promise.withResolvers<undefined>();
    first.writeGate = write.promise;
    const outcome = permissions.change(LABEL, { Camera: 'granted' });

    // When the app changes, its read held, and the write is released
    other.holdReads = true;
    productState.setLoaded({ label: 'other', productId: 'other.dot' });
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
    expect(permissions.state.get()).toEqual({ status: 'read', label: 'other', statuses: buildStatuses() });
  });

  it("As a user, I switch apps while the popover is open and never see the previous app's statuses for the new one", async () => {
    // Given
    createFakeCore('first', { Camera: 'Authorized' });
    createFakeCore('other');
    productState.setLoaded({ label: 'first', productId: 'first.dot' });
    await permissions.refresh();

    // When
    productState.setLoaded({ label: 'other', productId: 'other.dot' });

    // Then nothing shows until the new app's read lands
    expect(permissions.state.get()).toEqual({ status: 'reading', label: 'other' });

    // When
    await permissions.refresh();

    // Then
    expect(permissions.state.get()).toEqual({ status: 'read', label: 'other', statuses: buildStatuses() });
  });
});

function createFakeCore(label = LABEL, initial: Record<string, PermissionAuthorizationStatus> = {}): FakeCore {
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
      getPermissionAuthorizationStatuses(requests) {
        core.reads += 1;
        for (const woken of readWaiters.splice(0)) {
          woken(new Map(core.stored));
        }
        // A snapshot taken now, as the core would answer for the moment it was asked.
        const answer = requests.map(request => core.stored.get(getPermissionName(request)) ?? 'NotDetermined');
        if (!core.holdReads) {
          return Promise.resolve(answer);
        }
        return new Promise(resolve => {
          core.heldReads.push(() => {
            resolve(answer);
          });
        });
      },
      setPermissionAuthorizationStatus(request, status) {
        const failure = core.failWrite(getPermissionName(request));
        if (failure !== null) {
          return Promise.reject(failure);
        }
        if (core.writeGate === null) {
          storeWrite();
          return Promise.resolve();
        }
        return core.writeGate.then(storeWrite);

        function storeWrite(): void {
          core.writes.push({ name: getPermissionName(request), status });
          core.stored.set(getPermissionName(request), status);
        }
      },
    }),
  );
  return core;
}

function getPermissionName(request: PermissionAuthorizationRequest): string {
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
function buildStatuses(given: Record<string, 'ask' | 'granted' | 'denied'> = {}): string[] {
  return ALL_PERMISSIONS.map(({ name }) => given[name] ?? 'ask');
}

/** Every permission at `status`, as a preset move or the reset writes them. */
function buildAllTargets(status: 'ask' | 'granted' | 'denied'): Record<string, 'ask' | 'granted' | 'denied'> {
  return Object.fromEntries(ALL_PERMISSIONS.map(({ name }) => [name, status]));
}

function recordChanges(): PermissionsChange[] {
  const changes: PermissionsChange[] = [];
  cleanups.push(
    permissions.subscribeChanges(change => {
      changes.push(change);
    }),
  );
  return changes;
}

async function loadProduct(label = LABEL): Promise<void> {
  productState.setLoaded({ label, productId: `${label}.dot` });
  await permissions.refresh();
}

/** Replaces the store with one over the same registry whose retries wait on `timers`, which the test moves. */
function startPermissions(timers: ManualTimers): void {
  permissions = createProductPermissions({ registry, product: productState.store, timers });
  cleanups.push(permissions.start());
}
