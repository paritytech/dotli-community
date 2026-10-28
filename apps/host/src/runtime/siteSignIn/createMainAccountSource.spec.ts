// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { hashBlake2b, createSyncStore, fromHex, toHex, type ReadableStore } from '@dotli/shared';
import { must } from '@dotli/shared/testing';
import { createChanges } from '../../testing/changes.js';
import type { TruapiSessionUiState } from '../session/parseUiStateCache.js';
import type { DotliAuthState } from '../session/types.js';
import {
  createMainAccountSource,
  getMainAccount,
  MainAccountError,
  type MainAccount,
  type MainAccountSource,
} from './createMainAccountSource.js';

/** One lease the fake core handed out, which the test takes down. */
type FakeLease = {
  released: number;
  /** The core under this lease goes down, as the page core tells its holders. */
  goDown: () => void;
};

type Params = {
  /** What the first acquires reject with, one per call, where `undefined` lets that acquire succeed. */
  acquireFailures?: (Error | undefined)[];
};

const MAIN_KEY = `0x${'a'.repeat(64)}`;
const OWNER = toHex(hashBlake2b(fromHex(MAIN_KEY), 32));

const CONNECTED: DotliAuthState = {
  tag: 'Connected',
  session: { connected: true, publicKey: MAIN_KEY, fullUsername: 'alice.dot' },
};

/** A main-account source over a core whose leases the test counts and takes down, and a core report the test sets. */
function createSourceOverCore({ acquireFailures = [] }: Params = {}) {
  const changes = createChanges();
  const report = createSyncStore<DotliAuthState | null>({ name: 'testCoreReport', initial: null });
  let waits = 0;
  const coreReport: ReadableStore<DotliAuthState | null> = {
    get: report.get,
    initial: report.initial,
    subscribe(listener) {
      waits += 1;
      changes.notify();
      return report.subscribe(listener);
    },
  };
  const failures = [...acquireFailures];
  let acquires = 0;
  const leases: FakeLease[] = [];
  const source: MainAccountSource = createMainAccountSource({
    acquire() {
      acquires += 1;
      const failure = failures.shift();
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      const listeners = new Set<() => void>();
      const lease: FakeLease = {
        released: 0,
        goDown() {
          for (const listener of [...listeners]) {
            listener();
          }
        },
      };
      leases.push(lease);
      changes.notify();
      return Promise.resolve({
        subscribeDown(listener: () => void) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        release() {
          lease.released += 1;
        },
      });
    },
    coreReport,
  });
  return {
    source,
    report,
    countAcquires: () => acquires,
    leases,
    /** Resolves once a read waits on the core's report. */
    waitUntilReadWaits: () => changes.until(() => waits > 0),
    /** Resolves once the source took `count` leases. */
    waitForLeases: (count: number) => changes.until(() => leases.length >= count),
  };
}

/** A signal of a round that has not ended. */
function createLiveSignal(): AbortSignal {
  return new AbortController().signal;
}

describe('main account', () => {
  it.each<{ name: string; session: TruapiSessionUiState; username: MainAccount['username'] }>([
    {
      name: 'a full username',
      session: { connected: true, publicKey: MAIN_KEY, fullUsername: 'alice.dot', liteUsername: 'alice.01' },
      username: { name: 'alice.dot', kind: 'full' },
    },
    {
      name: 'a lite username alone, its full one empty,',
      session: { connected: true, publicKey: MAIN_KEY, fullUsername: '', liteUsername: 'alice.01' },
      username: { name: 'alice.01', kind: 'lite' },
    },
    { name: 'no username', session: { connected: true, publicKey: MAIN_KEY }, username: null },
  ])('As a site, I sign in for a main account with $name and get that username', ({ session, username }) => {
    // Given a session with that username
    const stored = session;

    // When the window reads the session's main account
    const main = getMainAccount(stored);

    // Then it carries that username
    expect(main).toEqual({ owner: OWNER, username });
  });

  it('As a site, I sign in for a main account whose session has no readable key and get none', () => {
    // Given sessions with no key, and with a key that is not hex
    const keyless = { connected: true, liteUsername: 'alice.01' };
    const unreadable = { connected: true, publicKey: 'not hex' };

    // When the window reads each session's main account
    const read = [getMainAccount(keyless), getMainAccount(unreadable)];

    // Then neither has one
    expect(read).toEqual([null, null]);
  });

  it("As a site, I sign in for a main account and its owner is the blake2b-256 hex of the account's key", () => {
    // Given a session with a key
    const session = { connected: true, publicKey: MAIN_KEY };

    // When the window reads the session's main account
    const main = getMainAccount(session);

    // Then its owner is the hash of the key
    expect(main?.owner).toBe(toHex(hashBlake2b(fromHex(MAIN_KEY), 32)));
  });

  it("As a user, I start a site's round and the main account read waits for the core's own report, never the saved copy", async () => {
    // Given a source whose core has not reported yet
    const core = createSourceOverCore();
    let settled = false;

    // When the round reads, and the core reports a session later
    const reading = core.source.read(createLiveSignal()).finally(() => {
      settled = true;
    });
    await core.waitUntilReadWaits();
    const pendingBeforeReport = !settled;
    core.report.set(CONNECTED);

    // Then the read waited for the core's report and resolves with its account
    expect(pendingBeforeReport).toBe(true);
    expect(await reading).toEqual({ owner: OWNER, username: { name: 'alice.dot', kind: 'full' } });
  });

  it("As a user, I start a site's round that reads the main account twice and it holds one core lease", async () => {
    // Given a core that reported a session
    const core = createSourceOverCore();
    core.report.set(CONNECTED);

    // When the round reads twice, overlapping, and once more after
    await Promise.all([core.source.read(createLiveSignal()), core.source.read(createLiveSignal())]);
    await core.source.read(createLiveSignal());

    // Then one lease was taken and it is still held
    expect(core.countAcquires()).toBe(1);
    expect(core.leases.map(lease => lease.released)).toEqual([0]);
  });

  it("As a user whose core cannot boot once, I start a site's round and the read fails, and a second read tries again", async () => {
    // Given a core that cannot boot once, and reports a session after
    const boot = new Error('The wallet core could not boot');
    const core = createSourceOverCore({ acquireFailures: [boot] });
    core.report.set(CONNECTED);

    // When the round reads, and reads again
    const failed: unknown = await core.source.read(createLiveSignal()).catch((error: unknown) => error);
    const main = await core.source.read(createLiveSignal());

    // Then the first read failed as unavailable with the boot's error, and the second took a lease and read the account
    expect(failed).toBeInstanceOf(MainAccountError);
    expect(failed).toMatchObject({ kind: 'unavailable', cause: boot });
    expect(main.owner).toBe(OWNER);
    expect(core.countAcquires()).toBe(2);
  });

  it("As a user whose stored session is dead, I start a site's round and the main account read fails as signed out", async () => {
    // Given a read that waits on the core's report
    const core = createSourceOverCore();
    const reading = core.source.read(createLiveSignal()).catch((error: unknown) => error);
    await core.waitUntilReadWaits();

    // When the core reports no session
    core.report.set({ tag: 'Disconnected' });
    const failed = await reading;

    // Then the read failed as signed out
    expect(failed).toBeInstanceOf(MainAccountError);
    expect(failed).toMatchObject({ kind: 'signed_out' });
  });

  it("As a user whose core reports a session with no key, I start a site's round and the read fails as unavailable", async () => {
    // Given a core that reports a session without a key
    const core = createSourceOverCore();
    core.report.set({ tag: 'Connected', session: { connected: true } });

    // When the round reads
    const failed: unknown = await core.source.read(createLiveSignal()).catch((error: unknown) => error);

    // Then the read failed as unavailable
    expect(failed).toMatchObject({ name: 'MainAccountError', kind: 'unavailable' });
  });

  it("As a user, I end a site's round while it waits on the main account and the read fails as unavailable", async () => {
    // Given a read that waits on the core's report
    const core = createSourceOverCore();
    const ended = new AbortController();
    const reading = core.source.read(ended.signal).catch((error: unknown) => error);
    await core.waitUntilReadWaits();

    // When the round ends
    ended.abort(new Error('The round ended'));

    // Then the read failed as unavailable
    expect(await reading).toMatchObject({ name: 'MainAccountError', kind: 'unavailable' });
  });

  it("As a user whose core went down, I go on with a site's round and the next read takes a lease on the replacement", async () => {
    // Given a read that holds a lease on a core that reported a session
    const core = createSourceOverCore();
    core.report.set(CONNECTED);
    await core.source.read(createLiveSignal());

    // When that core goes down, and the round reads again
    must(core.leases[0], 'a held lease').goDown();
    await core.source.read(createLiveSignal());

    // Then the lease on the core that went down was released, and the next read took a lease on the replacement
    expect(core.leases.map(lease => lease.released)).toEqual([1, 0]);
    expect(core.countAcquires()).toBe(2);
  });

  it("As a user whose core goes down while a site's round waits on the main account, I go on and the read takes the replacement's report", async () => {
    // Given a read that waits on the report of a core
    const core = createSourceOverCore();
    const reading = core.source.read(createLiveSignal());
    await core.waitUntilReadWaits();

    // When the core goes down, and its replacement reports a session
    must(core.leases[0], 'a held lease').goDown();
    await core.waitForLeases(2);
    core.report.set(CONNECTED);

    // Then the read took a lease on the replacement and resolved with its account
    expect((await reading).owner).toBe(OWNER);
    expect(core.leases.map(lease => lease.released)).toEqual([1, 0]);
    expect(core.countAcquires()).toBe(2);
  });

  it("As a user whose core goes down and cannot boot again while a site's round waits on the main account, I go on and the read fails as unavailable", async () => {
    // Given a read that waits on the report of a core whose replacement cannot boot
    const boot = new Error('The wallet core could not boot');
    const core = createSourceOverCore({ acquireFailures: [undefined, boot] });
    const reading = core.source.read(createLiveSignal()).catch((error: unknown) => error);
    await core.waitUntilReadWaits();

    // When the core goes down
    must(core.leases[0], 'a held lease').goDown();
    const failed = await reading;

    // Then the read failed as unavailable with the boot's error, once the source tried to lease the replacement
    expect(failed).toBeInstanceOf(MainAccountError);
    expect(failed).toMatchObject({ kind: 'unavailable', cause: boot });
    expect(core.leases.map(lease => lease.released)).toEqual([1]);
    expect(core.countAcquires()).toBe(2);
  });
});
