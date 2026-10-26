// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink, spans as S } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createChanges } from '../../testing/changes.js';
import { CoreRedialError } from '../page-core.js';
import type { WalletMode } from '../state/wallet-mode.js';
import type { SessionRead } from './core-storage.js';
import { createSessionLease } from './session-lease.js';

interface FakeLease {
  released: number;
  subscribed: number;
  /** Marks the core as down, so the next `subscribeDown` calls its listener at once. */
  down: boolean;
  listener: (() => void) | null;
  subscribeDown(listener: () => void): () => void;
  release(): void;
}

/** A session lease over a fake copy, wallet mode and core, whose reads and boots the test settles. */
function harness(initial: { blob: string | null; mode?: WalletMode }) {
  const changes = createChanges();
  const metrics = bindRecordingSentry({ onFinished: onTestFinished, onRecord: changes.notify });
  const captures = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));

  let blob = initial.blob;
  let mode: WalletMode = initial.mode ?? 'app';
  let failReads = false;
  let reads = 0;
  let heldRead: PromiseWithResolvers<SessionRead> | null = null;
  let onRead: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const copy = {
    readSession: (): Promise<SessionRead> => {
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
    },
    onStoredSessionChanged: (listener: () => void): (() => void) => {
      listeners.add(listener);
      changes.notify();
      return () => {
        listeners.delete(listener);
        changes.notify();
      };
    },
  };

  const leases: FakeLease[] = [];
  let heldAcquire: PromiseWithResolvers<undefined> | null = null;
  let rejectWith: Error | null = null;
  let nextDown = false;
  const core = {
    acquire: async (): Promise<FakeLease> => {
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
    },
  };

  const lease = createSessionLease({ copy, walletMode: () => mode, core });
  const fire = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };
  return {
    metrics,
    captures,
    changes,
    lease,
    leases,
    listeners,
    reads: () => reads,
    setBlob: (next: string | null) => {
      blob = next;
    },
    setMode: (next: WalletMode) => {
      mode = next;
    },
    failReads: () => {
      failReads = true;
    },
    /** The next read waits for the test to answer it. */
    holdRead: () => {
      heldRead = Promise.withResolvers<SessionRead>();
      return heldRead;
    },
    /** Runs while a read is answered. */
    onRead: (hook: () => void) => {
      onRead = hook;
    },
    holdAcquire: () => {
      heldAcquire = Promise.withResolvers<undefined>();
      return heldAcquire;
    },
    rejectAcquire: (error: Error) => {
      rejectWith = error;
    },
    markNextCoreDown: () => {
      nextDown = true;
    },
    fire,
    /** Waits until the lease has taken `count` leases and subscribed to the latest. */
    holding: (count = 1) => changes.until(() => leases.length === count && leases[count - 1]?.subscribed === 1),
    /** One more change and a wait for its read, which the pool starts only once the run under test ended. */
    anchor: async () => {
      const before = reads;
      fire();
      await changes.until(() => reads > before);
    },
  };
}

describe('session lease', () => {
  it('As a signed-in visitor, I open the landing page and it holds one core lease', async () => {
    // Given a copy with a paired session
    const page = harness({ blob: 'b1' });

    // When the landing page starts the lease
    page.lease.start();
    await page.holding();
    await page.anchor();

    // Then one lease is taken, kept and counted
    expect(page.leases).toHaveLength(1);
    expect(page.leases[0]?.released).toBe(0);
    expect(page.metrics.counted(S.WALLET_SESSION_LEASE)).toEqual([{ outcome: 'ok' }]);
  });

  it('As a signed-out visitor, I open the landing page and it boots no core', async () => {
    // Given a copy with no session
    const page = harness({ blob: null });

    // When the landing page starts the lease and the copy was read
    page.lease.start();
    await page.changes.until(() => page.reads() === 1);
    await page.anchor();

    // Then no core is taken
    expect(page.leases).toHaveLength(0);
  });

  it('As a visitor on a local wallet, I open the landing page and it boots no core', async () => {
    // Given a copy with a session and the local wallet on
    const page = harness({ blob: 'b1', mode: 'local' });

    // When the landing page starts the lease and the copy was read
    page.lease.start();
    await page.changes.until(() => page.reads() === 1);
    await page.anchor();

    // Then no core is taken
    expect(page.leases).toHaveLength(0);
  });

  it('As a signed-in visitor, I am disconnected by the phone and the lease goes', async () => {
    // Given a lease held for a paired session
    const page = harness({ blob: 'b1' });
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
    const page = harness({ blob: null });
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
    const page = harness({ blob: 'b1' });
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
    const page = harness({ blob: 'b1' });
    const boot = page.holdAcquire();
    page.lease.start();
    await page.changes.until(() => page.leases.length === 1);

    // When the copy loses its session, the change fires and the core then boots
    page.setBlob(null);
    page.fire();
    boot.resolve(undefined);
    await page.changes.until(() => page.leases[0]?.released === 1);
    await page.anchor();

    // Then the late lease was released and no second core was taken
    expect(page.leases).toHaveLength(1);
  });

  it('As a signed-in visitor, I keep my lease while the store cannot be read', async () => {
    // Given a lease held for a paired session
    const page = harness({ blob: 'b1' });
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

  it('As a signed-in visitor, I keep a core when mine goes down', async () => {
    // Given a lease held for a paired session
    const page = harness({ blob: 'b1' });
    page.lease.start();
    await page.holding();

    // When the core goes down
    page.leases[0]?.listener?.();
    await page.holding(2);

    // Then the old lease is released and a second one is held
    expect(page.leases[0]?.released).toBe(1);
    expect(page.metrics.counted(S.WALLET_SESSION_LEASE)).toEqual([{ outcome: 'ok' }, { outcome: 'ok' }]);
  });

  it('As a signed-in visitor, I keep a core when mine went down before its lease arrived', async () => {
    // Given a first core that is already down when its lease arrives
    const page = harness({ blob: 'b1' });
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
    const page = harness({ blob: 'b1', mode: 'app' });
    const boot = page.holdAcquire();
    page.lease.start();
    await page.changes.until(() => page.leases.length === 1);

    // When the wallet mode turns local and the core then boots
    page.setMode('local');
    boot.resolve(undefined);
    await page.changes.until(() => page.leases[0]?.released === 1);
    await page.anchor();

    // Then the lease is released and no second core is taken
    expect(page.leases).toHaveLength(1);
  });

  it('As a visitor on a local wallet, I open the landing page while the mode is still found and it boots no core', async () => {
    // Given a paired session whose mode turns local while the copy is read
    const page = harness({ blob: 'b1', mode: 'app' });
    page.onRead(() => {
      page.setMode('local');
    });

    // When the landing page starts the lease
    page.lease.start();
    await page.changes.until(() => page.reads() === 1);
    await page.anchor();

    // Then no core is taken
    expect(page.leases).toHaveLength(0);
  });

  it('As a signed-in visitor, I open the landing page when the core cannot boot and it tries again on the next change', async () => {
    // Given a first boot that fails
    const page = harness({ blob: 'b1' });
    page.rejectAcquire(new Error('boot'));

    // When the landing page starts the lease
    page.lease.start();
    await page.changes.until(() => page.metrics.counted(S.WALLET_SESSION_LEASE).length === 1);

    // Then the failure is counted and captured once
    expect(page.metrics.counted(S.WALLET_SESSION_LEASE)).toEqual([{ outcome: 'error', reason: 'boot' }]);
    expect(page.captures.exception).toHaveBeenCalledTimes(1);

    // When the copy changes again
    page.fire();
    await page.holding(2);

    // Then a second core is taken
    expect(page.leases).toHaveLength(2);
  });

  it('As a signed-in visitor, I lose a core that cannot be replaced and the failure is not reported twice', async () => {
    // Given a replacement that cannot boot
    const page = harness({ blob: 'b1' });
    page.rejectAcquire(new CoreRedialError(new Error('boot')));

    // When the landing page starts the lease
    page.lease.start();
    await page.changes.until(() => page.metrics.counted(S.WALLET_SESSION_LEASE).length === 1);

    // Then the redial is counted and recorded as expected, not captured as an exception
    expect(page.metrics.counted(S.WALLET_SESSION_LEASE)).toEqual([{ outcome: 'error', reason: 'redial' }]);
    expect(page.captures.expected).toHaveBeenCalledTimes(1);
    expect(page.captures.exception).not.toHaveBeenCalled();
  });

  it('As the landing page, I start the lease twice and it runs once', async () => {
    // Given a copy with a paired session
    const page = harness({ blob: 'b1' });

    // When the landing page starts the lease twice
    const first = page.lease.start();
    const second = page.lease.start();
    await page.holding();
    await page.anchor();

    // Then both calls return the same stop and one core is taken
    expect(second).toBe(first);
    expect(page.leases).toHaveLength(1);
  });

  it('As the landing page, I stop the lease and the held lease goes and later changes take none', async () => {
    // Given a lease held for a paired session
    const page = harness({ blob: 'b1' });
    const stop = page.lease.start();
    await page.holding();
    const readsBefore = page.reads();

    // When the landing page stops the lease twice and the copy changes after it
    stop();
    stop();
    expect(page.listeners.size).toBe(0);
    page.fire();
    const again = page.lease.start();

    // Then the lease is released once, the copy is not read again and a start after the stop takes nothing
    expect(page.leases[0]?.released).toBe(1);
    expect(page.reads()).toBe(readsBefore);
    expect(again).toBe(stop);
    expect(page.listeners.size).toBe(0);
    expect(page.leases).toHaveLength(1);
  });

  it('As the landing page, I stop the lease while the core boots and the late lease goes at once', async () => {
    // Given a core still booting for a paired session
    const page = harness({ blob: 'b1' });
    const boot = page.holdAcquire();
    const stop = page.lease.start();
    await page.changes.until(() => page.leases.length === 1);

    // When the landing page stops the lease and the core then boots
    stop();
    boot.resolve(undefined);
    await page.changes.until(() => page.leases[0]?.released === 1);
    const readsBefore = page.reads();
    expect(page.listeners.size).toBe(0);
    page.fire();

    // Then the late lease was released, the copy is not read again and no core is taken
    expect(page.reads()).toBe(readsBefore);
    expect(page.leases).toHaveLength(1);
  });

  it('As the landing page, I stop the lease while the copy is read and no core boots', async () => {
    // Given a read of the copy that waits for an answer
    const page = harness({ blob: 'b1' });
    const read = page.holdRead();
    const stop = page.lease.start();
    await page.changes.until(() => page.reads() === 1);

    // When the landing page stops the lease, the copy changes after it and the read then answers with a session
    stop();
    expect(page.listeners.size).toBe(0);
    page.fire();
    read.resolve({ status: 'ok', blob: 'b1' });
    await read.promise;

    // Then no core is taken and the copy is not read again
    expect(page.leases).toHaveLength(0);
    expect(page.reads()).toBe(1);
  });
});
