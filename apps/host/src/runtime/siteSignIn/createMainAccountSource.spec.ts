// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { hashBlake2b, createDeferred, fromHex, toHex } from '@dotli/shared';
import { atom, type ReadableAtom } from 'nanostores';
import { catchError, must } from '@dotli/shared/testing';
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
  /** How many down listeners the source keeps on this lease. */
  countListeners: () => number;
  /** The core under this lease goes down, as the page core tells its holders. */
  goDown: () => void;
};

type Params = {
  /** What the first acquires reject with, one per call, where `undefined` lets that acquire succeed. */
  acquireFailures?: (Error | undefined)[];
  /** Holds every lease that is taken until it resolves, as a core still booting does. */
  booted?: Promise<unknown>;
};

const MAIN_KEY = `0x${'a'.repeat(64)}`;
const OWNER = toHex(hashBlake2b(fromHex(MAIN_KEY), 32));

const CONNECTED: DotliAuthState = {
  tag: 'Connected',
  session: { connected: true, publicKey: MAIN_KEY, fullUsername: 'alice.dot' },
};

/** A main-account source over a core whose leases the test counts and takes down, and a core report the test sets. */
function createSourceOverCore({ acquireFailures = [], booted = Promise.resolve() }: Params = {}) {
  const changes = createChanges();
  const report = atom<DotliAuthState | null>(null);
  let waits = 0;
  const coreReport: Pick<ReadableAtom<DotliAuthState | null>, 'get' | 'listen'> = {
    get: () => report.get(),
    listen(listener) {
      waits += 1;
      changes.notify();
      return report.listen(listener);
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
        countListeners: () => listeners.size,
        goDown() {
          for (const listener of [...listeners]) {
            listener();
          }
        },
      };
      leases.push(lease);
      changes.notify();
      return booted.then(() => ({
        subscribeDown(listener: () => void) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        release() {
          lease.released += 1;
          changes.notify();
        },
      }));
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
    /** Resolves once the source let go of a lease. */
    waitForRelease: () => changes.until(() => leases.some(lease => lease.released > 0)),
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

  it("As a site, I sign in while the window's core cannot read the main session and the read fails as unavailable", async () => {
    // Given a core that reports it cannot read the main session
    const core = createSourceOverCore();
    core.report.set({ tag: 'Unreachable' });

    // When the round reads
    const failed: unknown = await core.source.read(createLiveSignal()).catch((error: unknown) => error);

    // Then the read failed as unavailable, naming the core
    expect(failed).toBeInstanceOf(MainAccountError);
    expect(failed).toMatchObject({ kind: 'unavailable', message: "The window's core cannot read the main session" });
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

  it('As a dotli integrator, I dispose the main account source and it lets go of its lease and hears no more of its core', async () => {
    // Given a source that holds a lease on a core that reported a session
    const core = createSourceOverCore();
    core.report.set(CONNECTED);
    await core.source.read(createLiveSignal());
    const lease = must(core.leases[0], 'a held lease');

    // When the source is disposed, and its core goes down after
    core.source.dispose();
    lease.goDown();

    // Then the lease was let go once, and the source keeps no down listener on it
    expect(lease.released).toBe(1);
    expect(lease.countListeners()).toBe(0);
  });

  it('As a dotli integrator, I dispose the main account source after its core could not boot and see no error', async () => {
    // Given a source whose read failed because its core could not boot
    const boot = new Error('The wallet core could not boot');
    const core = createSourceOverCore({ acquireFailures: [boot] });
    core.report.set(CONNECTED);
    await core.source.read(createLiveSignal()).catch((error: unknown) => error);

    // When the source is disposed
    const thrown = catchError(() => {
      core.source.dispose();
    });

    // Then nothing threw, and no lease was taken
    expect(thrown).toBeUndefined();
    expect(core.leases).toEqual([]);
  });

  it('As a dotli integrator, I dispose the main account source twice and see no error, and its lease is let go once', async () => {
    // Given a source that holds a lease and was disposed once
    const core = createSourceOverCore();
    core.report.set(CONNECTED);
    await core.source.read(createLiveSignal());
    core.source.dispose();

    // When it is disposed again
    const thrown = catchError(() => {
      core.source.dispose();
    });

    // Then nothing threw, and the lease was let go once
    expect(thrown).toBeUndefined();
    expect(core.leases.map(lease => lease.released)).toEqual([1]);
  });

  it('As a dotli integrator, I dispose the main account source while it takes a lease, and the lease is let go when it lands', async () => {
    // Given a read that takes a lease on a core still booting
    const booted = createDeferred<undefined>();
    const core = createSourceOverCore({ booted: booted.promise });
    const reading = core.source.read(createLiveSignal()).catch((error: unknown) => error);
    await core.waitForLeases(1);

    // When the source is disposed, and the core boots after
    core.source.dispose();
    booted.resolve(undefined);
    await core.waitForRelease();
    const failed = await reading;

    // Then the lease was let go once with no down listener kept on it, and the read failed as unavailable
    const lease = must(core.leases[0], 'the lease taken');
    expect(lease.released).toBe(1);
    expect(lease.countListeners()).toBe(0);
    expect(failed).toMatchObject({ name: 'MainAccountError', kind: 'unavailable' });
  });

  it('As a dotli integrator, I dispose the main account source while a read waits and the read fails as unavailable, with no new lease taken', async () => {
    // Given a read that waits on the report of a core
    const core = createSourceOverCore();
    const reading = core.source.read(createLiveSignal()).catch((error: unknown) => error);
    await core.waitUntilReadWaits();

    // When the source is disposed, and the core reports a session after
    core.source.dispose();
    core.report.set(CONNECTED);
    const failed = await reading;

    // Then the read failed as unavailable, and no lease was taken after the first
    expect(failed).toMatchObject({ name: 'MainAccountError', kind: 'unavailable' });
    expect(core.countAcquires()).toBe(1);
  });

  it('As a dotli integrator, I read from a disposed main account source and the read fails as unavailable, with no lease taken', async () => {
    // Given a disposed source over a core that reported a session
    const core = createSourceOverCore();
    core.report.set(CONNECTED);
    core.source.dispose();

    // When the round reads
    const failed: unknown = await core.source.read(createLiveSignal()).catch((error: unknown) => error);

    // Then the read failed as unavailable, and no lease was taken
    expect(failed).toMatchObject({ name: 'MainAccountError', kind: 'unavailable' });
    expect(core.countAcquires()).toBe(0);
  });
});
