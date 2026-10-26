// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { blake2b, createSyncStore, fromHex, toHex, type ReadableStore } from '@dotli/shared';
import { must } from '@dotli/shared/testing';
import { createChanges } from '../../testing/changes.js';
import type { DotliAuthState } from '../session/auth-state.js';
import { createMainAccountSource, mainAccountOf, MainAccountError, type MainAccountSource } from './main-account.js';

const MAIN_KEY = `0x${'a'.repeat(64)}`;
const OWNER = toHex(blake2b(fromHex(MAIN_KEY), 32));

const CONNECTED: DotliAuthState = {
  tag: 'Connected',
  session: { connected: true, publicKey: MAIN_KEY, fullUsername: 'alice.dot' },
};

/** One lease the fake core handed out, which the test takes down. */
type FakeLease = {
  released: number;
  /** The core under this lease goes down, as the page core tells its holders. */
  goDown: () => void;
};

/**
 * A main-account source over a core whose leases the test counts and takes down, and a core report the test sets.
 * `acquireFailures` are what the first acquires reject with, one per call, where `undefined` lets that acquire succeed.
 */
function harness({ acquireFailures = [] }: { acquireFailures?: (Error | undefined)[] } = {}) {
  const changes = createChanges();
  const report = createSyncStore<DotliAuthState | null>('testCoreReport', null);
  let waits = 0;
  const coreReport: ReadableStore<DotliAuthState | null> = {
    get: report.get,
    initial: report.initial,
    subscribe: listener => {
      waits += 1;
      changes.notify();
      return report.subscribe(listener);
    },
  };
  const failures = [...acquireFailures];
  let acquires = 0;
  const leases: FakeLease[] = [];
  const source: MainAccountSource = createMainAccountSource({
    acquire: () => {
      acquires += 1;
      const failure = failures.shift();
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      const listeners = new Set<() => void>();
      const lease: FakeLease = {
        released: 0,
        goDown: () => {
          for (const listener of [...listeners]) {
            listener();
          }
        },
      };
      leases.push(lease);
      changes.notify();
      return Promise.resolve({
        subscribeDown: listener => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        release: () => {
          lease.released += 1;
        },
      });
    },
    coreReport,
  });
  return {
    source,
    report,
    acquires: () => acquires,
    leases,
    /** Resolves once a read waits on the core's report. */
    untilWaiting: () => changes.until(() => waits > 0),
    /** Resolves once the source took `count` leases. */
    untilLeases: (count: number) => changes.until(() => leases.length >= count),
  };
}

const live = (): AbortSignal => new AbortController().signal;

describe('main account', () => {
  it('As a site, I sign in for a main account with a full username and get the full username', () => {
    // Given a session with a full and a lite username
    const session = { connected: true, publicKey: MAIN_KEY, fullUsername: 'alice.dot', liteUsername: 'alice.01' };

    // When the window reads the session's main account
    const main = mainAccountOf(session);

    // Then it carries the full username
    expect(main).toEqual({ owner: OWNER, username: { name: 'alice.dot', kind: 'full' } });
  });

  it('As a site, I sign in for a main account with a lite username alone and get the lite username', () => {
    // Given a session with only a lite username, its full one empty
    const session = { connected: true, publicKey: MAIN_KEY, fullUsername: '', liteUsername: 'alice.01' };

    // When the window reads the session's main account
    const main = mainAccountOf(session);

    // Then it carries the lite username
    expect(main?.username).toEqual({ name: 'alice.01', kind: 'lite' });
  });

  it('As a site, I sign in for a main account with no username and get none', () => {
    // Given a session with no username
    const session = { connected: true, publicKey: MAIN_KEY };

    // When the window reads the session's main account
    const main = mainAccountOf(session);

    // Then it carries no username
    expect(main?.username).toBeNull();
  });

  it('As the window, I read a main account without a public key and get none', () => {
    // Given sessions with no key, and with a key that is not hex
    const keyless = { connected: true, liteUsername: 'alice.01' };
    const unreadable = { connected: true, publicKey: 'not hex' };

    // When the window reads each session's main account
    const read = [mainAccountOf(keyless), mainAccountOf(unreadable)];

    // Then neither has one
    expect(read).toEqual([null, null]);
  });

  it('As the window, I read the main account and its owner is the blake2b-256 hex of the key', () => {
    // Given a session with a key
    const session = { connected: true, publicKey: MAIN_KEY };

    // When the window reads the session's main account
    const main = mainAccountOf(session);

    // Then its owner is the hash of the key
    expect(main?.owner).toBe(toHex(blake2b(fromHex(MAIN_KEY), 32)));
  });

  it("As the window, I read the main account and wait for the core's own report, never the saved copy", async () => {
    // Given a source whose core has not reported yet
    const h = harness();
    let settled = false;

    // When the round reads, and the core reports a session later
    const reading = h.source.read(live()).finally(() => {
      settled = true;
    });
    await h.untilWaiting();
    const pendingBeforeReport = !settled;
    h.report.set(CONNECTED);

    // Then the read waited for the core's report and resolves with its account
    expect(pendingBeforeReport).toBe(true);
    expect(await reading).toEqual({ owner: OWNER, username: { name: 'alice.dot', kind: 'full' } });
  });

  it('As the window, I read the main account twice and hold one core lease', async () => {
    // Given a core that reported a session
    const h = harness();
    h.report.set(CONNECTED);

    // When the round reads twice, overlapping, and once more after
    await Promise.all([h.source.read(live()), h.source.read(live())]);
    await h.source.read(live());

    // Then one lease was taken and it is still held
    expect(h.acquires()).toBe(1);
    expect(h.leases.map(lease => lease.released)).toEqual([0]);
  });

  it('As the window, I read the main account while the core cannot boot and the read fails, and a second read tries again', async () => {
    // Given a core that cannot boot once, and reports a session after
    const boot = new Error('The wallet core could not boot');
    const h = harness({ acquireFailures: [boot] });
    h.report.set(CONNECTED);

    // When the round reads, and reads again
    const failed: unknown = await h.source.read(live()).catch((error: unknown) => error);
    const main = await h.source.read(live());

    // Then the first read failed as unavailable with the boot's error, and the second took a lease and read the account
    expect(failed).toBeInstanceOf(MainAccountError);
    expect(failed).toMatchObject({ kind: 'unavailable', cause: boot });
    expect(main.owner).toBe(OWNER);
    expect(h.acquires()).toBe(2);
  });

  it('As the window, I read the main account of a dead stored session and the read fails as signed out', async () => {
    // Given a read that waits on the core's report
    const h = harness();
    const reading = h.source.read(live()).catch((error: unknown) => error);
    await h.untilWaiting();

    // When the core reports no session
    h.report.set({ tag: 'Disconnected' });

    // Then the read failed as signed out
    const failed = await reading;
    expect(failed).toBeInstanceOf(MainAccountError);
    expect(failed).toMatchObject({ kind: 'signed_out' });
  });

  it('As the window, I read the main account of a core whose session has no key and the read fails as unavailable', async () => {
    // Given a core that reports a session without a key
    const h = harness();
    h.report.set({ tag: 'Connected', session: { connected: true } });

    // When the round reads
    const failed: unknown = await h.source.read(live()).catch((error: unknown) => error);

    // Then the read failed as unavailable
    expect(failed).toMatchObject({ name: 'MainAccountError', kind: 'unavailable' });
  });

  it('As the window, I read the main account and the round ends while I wait, and the read fails as unavailable', async () => {
    // Given a read that waits on the core's report
    const h = harness();
    const ended = new AbortController();
    const reading = h.source.read(ended.signal).catch((error: unknown) => error);
    await h.untilWaiting();

    // When the round ends
    ended.abort(new Error('The round ended'));

    // Then the read failed as unavailable
    expect(await reading).toMatchObject({ name: 'MainAccountError', kind: 'unavailable' });
  });

  it('As the window, I read the main account after its core went down and the read takes a lease on the replacement', async () => {
    // Given a read that holds a lease on a core that reported a session
    const h = harness();
    h.report.set(CONNECTED);
    await h.source.read(live());

    // When that core goes down, and the round reads again
    must(h.leases[0], 'a held lease').goDown();
    await h.source.read(live());

    // Then the lease on the core that went down was released, and the next read took a lease on the replacement
    expect(h.leases.map(lease => lease.released)).toEqual([1, 0]);
    expect(h.acquires()).toBe(2);
  });

  it("As the window, I wait on the main account while its core goes down and read the replacement's report", async () => {
    // Given a read that waits on the report of a core
    const h = harness();
    const reading = h.source.read(live());
    await h.untilWaiting();

    // When the core goes down, and its replacement reports a session
    must(h.leases[0], 'a held lease').goDown();
    await h.untilLeases(2);
    h.report.set(CONNECTED);

    // Then the read took a lease on the replacement and resolved with its account
    expect((await reading).owner).toBe(OWNER);
    expect(h.leases.map(lease => lease.released)).toEqual([1, 0]);
    expect(h.acquires()).toBe(2);
  });

  it('As the window, I wait on the main account while its core goes down and the replacement cannot boot, and the read fails as unavailable', async () => {
    // Given a read that waits on the report of a core whose replacement cannot boot
    const boot = new Error('The wallet core could not boot');
    const h = harness({ acquireFailures: [undefined, boot] });
    const reading = h.source.read(live()).catch((error: unknown) => error);
    await h.untilWaiting();

    // When the core goes down
    must(h.leases[0], 'a held lease').goDown();

    // Then the read failed as unavailable with the boot's error, once the source tried to lease the replacement
    const failed = await reading;
    expect(failed).toBeInstanceOf(MainAccountError);
    expect(failed).toMatchObject({ kind: 'unavailable', cause: boot });
    expect(h.leases.map(lease => lease.released)).toEqual([1]);
    expect(h.acquires()).toBe(2);
  });
});
