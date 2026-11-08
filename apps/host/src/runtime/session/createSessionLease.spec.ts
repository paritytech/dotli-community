// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createChanges } from '../../testing/changes.js';
import { CoreRedialError } from '../coreRedialError.js';
import type { SessionRead } from './createCoreStorage.js';
import { createSessionLease } from './createSessionLease.js';

type FakeLease = {
  released: number;
  subscribed: number;
  /** Marks the core as down, so the next `subscribeDown` calls its listener at once. */
  down: boolean;
  listener: (() => void) | null;
  subscribeDown(listener: () => void): () => void;
  release(): void;
};

/** A session lease over a fake copy, wallet mode and core, whose reads and boots the test settles. */
function createLeaseHarness(initial: { blob: string | null; local?: boolean }) {
  const changes = createChanges();
  const metrics = bindRecordingSentry({ onFinished: onTestFinished, onRecord: changes.notify });
  const captures = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));

  let blob = initial.blob;
  let local = initial.local ?? false;
  let failReads = false;
  let reads = 0;
  let heldRead: PromiseWithResolvers<SessionRead> | null = null;
  let onRead: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const leases: FakeLease[] = [];
  let heldAcquire: PromiseWithResolvers<undefined> | null = null;
  let rejectWith: Error | null = null;
  let nextDown = false;

  const lease = createSessionLease({
    copy: { readSession, subscribeStoredSession },
    isLocalWallet: () => local,
    core: { acquire },
  });
  return {
    metrics,
    captures,
    changes,
    lease,
    leases,
    listeners,
    reads: () => reads,
    setBlob,
    setLocal,
    failReads: failNextReads,
    /** The next read waits for the test to answer it. */
    holdRead,
    /** Runs while a read is answered. */
    onRead: setReadHook,
    holdAcquire,
    rejectAcquire,
    markNextCoreDown,
    fire,
    /** Waits until the lease has taken `count` leases and subscribed to the latest. */
    holding: (count = 1) => changes.until(() => leases.length === count && leases[count - 1]?.subscribed === 1),
    /** One more change and a wait for its read, which the pool starts only once the run under test ended. */
    anchor,
  };

  function readSession(): Promise<SessionRead> {
    reads += 1;
    const answer: SessionRead = failReads ? { status: 'failed', error: new Error('store') } : { status: 'ok', blob };
    changes.notify();
    if (heldRead !== null) {
      const held = heldRead;
      heldRead = null;
      return held.promise;
    }
    onRead?.();
    return Promise.resolve(answer);
  }

  function subscribeStoredSession(listener: () => void): () => void {
    listeners.add(listener);
    changes.notify();
    return unsubscribe;

    function unsubscribe(): void {
      listeners.delete(listener);
      changes.notify();
    }
  }

  async function acquire(): Promise<FakeLease> {
    const lease: FakeLease = {
      released: 0,
      subscribed: 0,
      down: nextDown,
      listener: null,
      subscribeDown(listener) {
        lease.subscribed += 1;
        lease.listener = listener;
        changes.notify();
        if (lease.down) {
          listener();
        }
        return () => undefined;
      },
      release() {
        lease.released += 1;
        changes.notify();
      },
    };
    nextDown = false;
    leases.push(lease);
    changes.notify();
    const hold = heldAcquire;
    const error = rejectWith;
    heldAcquire = null;
    rejectWith = null;
    if (hold !== null) {
      await hold.promise;
    }
    if (error !== null) {
      throw error;
    }
    return lease;
  }

  function fire(): void {
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function setBlob(next: string | null): void {
    blob = next;
  }

  function setLocal(next: boolean): void {
    local = next;
  }

  function failNextReads(): void {
    failReads = true;
  }

  function holdRead(): PromiseWithResolvers<SessionRead> {
    const held = Promise.withResolvers<SessionRead>();
    heldRead = held;
    return held;
  }

  function setReadHook(hook: () => void): void {
    onRead = hook;
  }

  function holdAcquire(): PromiseWithResolvers<undefined> {
    const held = Promise.withResolvers<undefined>();
    heldAcquire = held;
    return held;
  }

  function rejectAcquire(error: Error): void {
    rejectWith = error;
  }

  function markNextCoreDown(): void {
    nextDown = true;
  }

  async function anchor(): Promise<void> {
    const before = reads;
    fire();
    await changes.until(() => reads > before);
  }
}

describe('session lease', () => {
  it('As a signed-in visitor, I open the landing page and it holds one core lease', async () => {
    // Given a copy with a paired session
    const page = createLeaseHarness({ blob: 'b1' });

    // When the landing page starts the lease
    page.lease.start();
    await page.holding();
    await page.anchor();

    // Then one lease is taken, kept and counted
    expect(page.leases).toHaveLength(1);
    expect(page.leases[0]?.released).toBe(0);
    expect(page.metrics.counted('wallet.session_lease')).toEqual([{ outcome: 'ok' }]);
  });

  it.each<{ label: string; blob: string | null; local: boolean; localWhenRead: boolean }>([
    { label: 'signed-out visitor, I open the landing page', blob: null, local: false, localWhenRead: false },
    { label: 'visitor on a local wallet, I open the landing page', blob: 'b1', local: true, localWhenRead: true },
    {
      label: 'visitor on a local wallet, I open the landing page while the mode is still found',
      blob: 'b1',
      local: false,
      localWhenRead: true,
    },
  ])('As a $label and it boots no core', async ({ blob, local, localWhenRead }) => {
    // Given a copy and a wallet mode, which may turn while the copy is read
    const page = createLeaseHarness({ blob, local });
    page.onRead(() => {
      page.setLocal(localWhenRead);
    });

    // When the landing page starts the lease and the copy was read
    page.lease.start();
    await page.changes.until(() => page.reads() === 1);
    await page.anchor();

    // Then no core is taken
    expect(page.leases).toHaveLength(0);
  });

  it('As a signed-in visitor, I am disconnected by the phone and the lease goes', async () => {
    // Given a lease held for a paired session
    const page = createLeaseHarness({ blob: 'b1' });
    page.lease.start();
    await page.holding();

    // When the copy loses its session and the change fires
    page.setBlob(null);
    page.fire();
    await page.changes.until(() => page.leases[0]?.released === 1);
    await page.anchor();

    // Then the lease is released once
    expect(page.leases[0]?.released).toBe(1);
  });

  it('As a visitor, I sign in on the landing page and the lease follows the stored session', async () => {
    // Given a started lease over a copy with no session
    const page = createLeaseHarness({ blob: null });
    page.lease.start();
    await page.changes.until(() => page.reads() === 1);

    // When the copy gets a session and the change fires
    page.setBlob('b1');
    page.fire();
    await page.holding();
    await page.anchor();

    // Then one core is taken
    expect(page.leases).toHaveLength(1);
  });

  it('As a signed-in visitor, I see repeated changes of the copy and the page holds one lease', async () => {
    // Given a lease held for a paired session
    const page = createLeaseHarness({ blob: 'b1' });
    page.lease.start();
    await page.holding();

    // When the copy changes three times with the same session
    page.fire();
    page.fire();
    page.fire();
    await page.changes.until(() => page.reads() === 4);
    await page.anchor();

    // Then the page still holds the one lease
    expect(page.leases).toHaveLength(1);
    expect(page.leases[0]?.released).toBe(0);
  });

  it('As a signed-in visitor, I sign out while the core still boots and no lease stays', async () => {
    // Given a core that is still booting for a paired session
    const page = createLeaseHarness({ blob: 'b1' });
    const boot = page.holdAcquire();
    page.lease.start();
    await page.changes.until(() => page.leases.length === 1);

    // When the copy loses its session, the change fires and the core boots after it
    page.setBlob(null);
    page.fire();
    boot.resolve(undefined);
    await page.changes.until(() => page.leases[0]?.released === 1);
    await page.anchor();

    // Then the late lease was released and no second core was taken
    expect(page.leases).toHaveLength(1);
  });

  it('As a signed-in visitor, I see the copy change while the store cannot be read and keep my lease', async () => {
    // Given a lease held for a paired session
    const page = createLeaseHarness({ blob: 'b1' });
    page.lease.start();
    await page.holding();

    // When the store cannot be read for the change and for the anchor
    page.failReads();
    page.fire();
    await page.changes.until(() => page.reads() === 2);
    await page.anchor();

    // Then the lease stays and no second core is taken
    expect(page.leases).toHaveLength(1);
    expect(page.leases[0]?.released).toBe(0);
  });

  it('As a signed-in visitor, I lose my core and a new core lease is held', async () => {
    // Given a lease held for a paired session
    const page = createLeaseHarness({ blob: 'b1' });
    page.lease.start();
    await page.holding();

    // When the core goes down
    page.leases[0]?.listener?.();
    await page.holding(2);

    // Then the old lease is released and a second one is held
    expect(page.leases[0]?.released).toBe(1);
    expect(page.metrics.counted('wallet.session_lease')).toEqual([{ outcome: 'ok' }, { outcome: 'ok' }]);
  });

  it('As a signed-in visitor, I open the landing page while my first core is already down and a second core lease is held', async () => {
    // Given a first core that is already down when its lease arrives
    const page = createLeaseHarness({ blob: 'b1' });
    page.markNextCoreDown();

    // When the landing page starts the lease
    page.lease.start();
    await page.holding(2);
    await page.anchor();

    // Then the first lease is released and the second one is held
    expect(page.leases[0]?.released).toBe(1);
    expect(page.leases[1]?.released).toBe(0);
  });

  it('As a visitor on a local wallet the boot could not read, I open the landing page and it keeps no core', async () => {
    // Given a core booting for a paired session
    const page = createLeaseHarness({ blob: 'b1', local: false });
    const boot = page.holdAcquire();
    page.lease.start();
    await page.changes.until(() => page.leases.length === 1);

    // When the wallet mode turns local and the core boots after it
    page.setLocal(true);
    boot.resolve(undefined);
    await page.changes.until(() => page.leases[0]?.released === 1);
    await page.anchor();

    // Then the lease is released and no second core is taken
    expect(page.leases).toHaveLength(1);
  });

  it('As a signed-in visitor, I open the landing page when the core cannot boot and it tries again on the next change', async () => {
    // Given a first boot that fails
    const page = createLeaseHarness({ blob: 'b1' });
    page.rejectAcquire(new Error('boot'));

    // When the landing page starts the lease
    page.lease.start();
    await page.changes.until(() => page.metrics.counted('wallet.session_lease').length === 1);

    // Then the failure is counted and captured once
    expect(page.metrics.counted('wallet.session_lease')).toEqual([{ outcome: 'error', reason: 'boot' }]);
    expect(page.captures.exception).toHaveBeenCalledTimes(1);

    // When the copy changes again
    page.fire();
    await page.holding(2);

    // Then a second core is taken
    expect(page.leases).toHaveLength(2);
  });

  it('As a signed-in visitor, I lose a core that cannot be replaced and the failure is not reported twice', async () => {
    // Given a replacement that cannot boot
    const page = createLeaseHarness({ blob: 'b1' });
    page.rejectAcquire(new CoreRedialError(new Error('boot')));

    // When the landing page starts the lease
    page.lease.start();
    await page.changes.until(() => page.metrics.counted('wallet.session_lease').length === 1);

    // Then the redial is counted and recorded as expected, not captured as an exception
    expect(page.metrics.counted('wallet.session_lease')).toEqual([{ outcome: 'error', reason: 'redial' }]);
    expect(page.captures.expected).toHaveBeenCalledTimes(1);
    expect(page.captures.exception).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, I start the lease twice and it runs once', async () => {
    // Given a copy with a paired session
    const page = createLeaseHarness({ blob: 'b1' });

    // When the landing page starts the lease twice
    const first = page.lease.start();
    const second = page.lease.start();
    await page.holding();
    await page.anchor();

    // Then both calls return the same stop and one core is taken
    expect(second).toBe(first);
    expect(page.leases).toHaveLength(1);
  });

  it('As a dotli integrator, I stop the lease and the held lease goes while later changes take none', async () => {
    // Given a lease held for a paired session
    const page = createLeaseHarness({ blob: 'b1' });
    const stop = page.lease.start();
    await page.holding();
    const readsBefore = page.reads();

    // When the landing page stops the lease twice and the copy changes after it
    stop();
    stop();
    page.fire();
    const again = page.lease.start();

    // Then the lease is released once, the copy is not read again and a start after the stop takes nothing
    expect(page.leases[0]?.released).toBe(1);
    expect(page.reads()).toBe(readsBefore);
    expect(again).toBe(stop);
    expect(page.listeners.size).toBe(0);
    expect(page.leases).toHaveLength(1);
  });

  it('As a dotli integrator, I stop the lease while the core boots and the late lease goes at once', async () => {
    // Given a core still booting for a paired session
    const page = createLeaseHarness({ blob: 'b1' });
    const boot = page.holdAcquire();
    const stop = page.lease.start();
    await page.changes.until(() => page.leases.length === 1);

    // When the landing page stops the lease and the core boots after it
    stop();
    boot.resolve(undefined);
    await page.changes.until(() => page.leases[0]?.released === 1);
    const readsBefore = page.reads();
    page.fire();

    // Then the late lease was released, the copy is not read again and no core is taken
    expect(page.listeners.size).toBe(0);
    expect(page.reads()).toBe(readsBefore);
    expect(page.leases).toHaveLength(1);
  });

  it('As a dotli integrator, I stop the lease while the copy is read and no core boots', async () => {
    // Given a read of the copy that waits for an answer
    const page = createLeaseHarness({ blob: 'b1' });
    const read = page.holdRead();
    const stop = page.lease.start();
    await page.changes.until(() => page.reads() === 1);

    // When the landing page stops the lease, the copy changes after it and the read answers with a session last
    stop();
    page.fire();
    read.resolve({ status: 'ok', blob: 'b1' });
    await read.promise;

    // Then no core is taken and the copy is not read again
    expect(page.listeners.size).toBe(0);
    expect(page.leases).toHaveLength(0);
    expect(page.reads()).toBe(1);
  });
});
