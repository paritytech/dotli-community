// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createAsyncTaskPool, createDeferred } from '@dotli/shared';
import { catchRejection, nth } from '@dotli/shared/testing';
import { bindReports } from '../testing/bindReports.js';
import type { SessionRead } from './session/createCoreStorage.js';
import type { Presence } from './session/types.js';
import { createFakeSessionPresence } from './session/createPagePresence.fake.js';
import { createPageSignOut, type PageSignOutParams } from './createPageSignOut.js';
import type { WalletSwitchOutcome } from './createWalletSwitch.js';
import { createChanges } from '../testing/changes.js';

/** What the page's copy of the paired session holds, which the window's restore rule or a visible check may clear. */
type CopyState = {
  /** The paired session the copy holds, null for none. */
  held: string | null;
  /** While set, every read answers it. */
  readFailure: Error | null;
};

/** The main store's local wallet, whose record a save elsewhere replaces with a new version. */
type FakeWallet = {
  version: number | null;
  /** While set, every read rejects with it. */
  readFailure: Error | null;
};

type CreateHarnessParams = {
  /** Whether the page runs on a local wallet, paired by default. */
  local?: boolean;
  /** The paired session the page's copy holds, one by default. */
  held?: string | null;
  /** The signed-in flag as a local sign-out reads it, gone by default, as the sign-out deleted it. */
  flag?: Presence;
  /** What the switch back from local mode answers, a reload by default. */
  leaveOutcome?: WalletSwitchOutcome;
  /** The local wallet's record version in the main store, one by default, null for none. */
  wallet?: number | null;
  /** Runs a sign-out's end on the core once this settles, as a login still open holds it. */
  coreFree?: Promise<void>;
  /** A product's sign-out window that already read the paired session by default. */
  signOutWindow?: PageSignOutParams['signOutWindow'];
};

type CreateFakeCopyParams = {
  /** The paired session the copy holds at first, null for none. */
  held: string | null;
  /** Takes a record of each drop. */
  calls: string[];
};

/** A page's sign-out over fakes, with a fake Sentry and capture sink bound for this test. */
function createHarness({
  local = false,
  held = '0xsession',
  flag = 'absent',
  leaveOutcome,
  wallet: walletVersion = 1,
  coreFree,
  signOutWindow = createProductWindow(Promise.resolve()),
}: CreateHarnessParams = {}) {
  const { captures, counted } = bindReports();
  const changes = createChanges();
  const calls: string[] = [];
  const copy = createFakeCopy({ held, calls });
  let flagClears = 0;
  const endSession = vi.fn((blob: string) => {
    calls.push(`end ${blob}`);
    return Promise.resolve();
  });
  const resetSession = vi.fn(() => {
    calls.push('reset');
    return Promise.resolve();
  });
  const reportSignedOut = vi.fn(() => {
    calls.push('signed out');
  });
  const wallet: FakeWallet = { version: walletVersion, readFailure: null };
  // Runs the `forget` it is given before it answers.
  const leaveLocalWallet = vi.fn(async (forget: () => Promise<void>) => {
    calls.push('leave local');
    if (leaveOutcome === 'failed') {
      return 'failed';
    }
    await forget();
    return 'reloading';
  });
  const forgetGrants = vi.fn(() => Promise.resolve());
  const signOuts = createAsyncTaskPool({ poolSize: 1 });
  // A spy of its own, since a mock does not keep the logout's type parameter.
  const coreRun = vi.fn<() => void>();
  const signingOut: boolean[] = [];
  const signOut = createPageSignOut({
    isLocalWallet: () => local,
    copy,
    flag: {
      async clear(clearOptions) {
        flagClears += 1;
        return (await clearOptions?.drop?.()) ?? false;
      },
    },
    endSession,
    cores: { resetSession },
    session: { reportSignedOut },
    leaveLocalWallet,
    forgetGrants,
    wallet: {
      read() {
        if (wallet.readFailure !== null) {
          return Promise.reject(wallet.readFailure);
        }
        const { version } = wallet;
        return Promise.resolve(
          version === null
            ? { status: 'none' }
            : { status: 'ok', entropy: Uint8Array.of(1), identity: null, version: Uint8Array.of(version) },
        );
      },
      forgetIf(version) {
        const holds = wallet.version === version[0];
        if (holds) {
          calls.push('forget wallet');
          wallet.version = null;
        }
        return Promise.resolve(holds);
      },
    },
    presence: createFakeSessionPresence({ state: flag }),
    reportSigningOut: pending => {
      signingOut.push(pending);
      changes.notify();
    },
    signOutWindow,
    signOuts,
    runOnCore,
  });
  return {
    signOut,
    copy,
    /** How many clears the flag keeper ran. */
    countFlagClears: (): number => flagClears,
    endSession,
    resetSession,
    reportSignedOut,
    leaveLocalWallet,
    /** Forgets every site signed in through the session window. */
    forgetGrants,
    wallet,
    signOuts,
    /** Each end the sign-out ran through the core commands. */
    runOnCore: coreRun,
    /** Each status the sign-out reported, in order. */
    signingOut,
    /** Every call the sign-out made on the cores, the phone and the copy, in order. */
    calls,
    changes,
    captures,
    counted,
  };

  async function runOnCore<T>(end: () => Promise<T>): Promise<T> {
    coreRun();
    await coreFree;
    return end();
  }
}

/** The page's copy of the paired session over `held`. Records each drop in `calls`. */
function createFakeCopy({ held, calls }: CreateFakeCopyParams) {
  const state: CopyState = { held, readFailure: null };
  return Object.assign(state, {
    readSession: vi.fn(() =>
      Promise.resolve<SessionRead>(
        state.readFailure === null
          ? { status: 'ok', blob: state.held }
          : { status: 'failed', error: state.readFailure },
      ),
    ),
    dropSessionIf: vi.fn((blob: string) => {
      calls.push(`drop ${blob}`);
      if (state.held !== blob) {
        return Promise.resolve(false);
      }
      state.held = null;
      return Promise.resolve(true);
    }),
  });
}

/** A product's sign-out window, which tells the phone and whose read settles with `read`. */
function createProductWindow(read: Promise<void>): PageSignOutParams['signOutWindow'] {
  return () => ({ signOutRead: () => read });
}

/** The wallet record another tab saves, a new version of whatever it holds. */
function saveElsewhere(wallet: FakeWallet): void {
  wallet.version = (wallet.version ?? 0) + 1;
}

/** A page that pairs in place, which has no sign-out window, so nothing tells the phone in local mode. */
function openNoWindow(): null {
  return null;
}

describe('paired sign-out', () => {
  it('As a user in paired mode, I sign out and my cores and copy let the session go, which a core of my own then ends on the phone', async () => {
    // Given a paired page holding a session in its copy
    const fakes = createHarness();

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the page lets go first, since it holds the session itself, and the phone is told about the session it held
    expect(fakes.calls).toEqual(['reset', 'drop 0xsession', 'signed out', 'end 0xsession']);
    expect(fakes.copy.held).toBeNull();
    expect(fakes.countFlagClears()).toBe(1);
    expect(fakes.runOnCore).toHaveBeenCalledTimes(1);
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'ok' }]);
    expect(fakes.captures.exception).not.toHaveBeenCalled();
  });

  it('As a user on a product page in a browser that shares the main store, I sign out after the sign-out window cleared that store and the phone is still told about my session', async () => {
    // Given a login still open, so the sign-out's end on the core waits on a core that still boots
    const coreFree = createDeferred<undefined>();
    const fakes = createHarness({ coreFree: coreFree.promise });

    // When I sign out, and the window's restore rule clears the store, which is my copy, before my end runs
    const signOut = fakes.signOut.signOut();
    const readAtOnce = fakes.copy.readSession.mock.calls.length;
    fakes.copy.held = null;
    coreFree.resolve(undefined);
    await signOut;

    // Then my copy was read before the call returned, and that session is the one ended on the phone
    expect(readAtOnce).toBe(1);
    expect(fakes.endSession).toHaveBeenCalledWith('0xsession');
    expect(fakes.reportSignedOut).toHaveBeenCalledTimes(1);
  });

  it('As a user signed in again elsewhere before my sign-out let my copy go, I sign out and that sign-in stays', async () => {
    // Given a sign-out waiting to run
    const coreFree = createDeferred<undefined>();
    const fakes = createHarness({ coreFree: coreFree.promise });
    const signOut = fakes.signOut.signOut();

    // When a new sign-in lands in the copy first
    fakes.copy.held = '0xnew';
    coreFree.resolve(undefined);
    await signOut;

    // Then only the session I held is ended and cleared
    expect(fakes.copy.held).toBe('0xnew');
    expect(fakes.endSession).toHaveBeenCalledWith('0xsession');
  });

  it('As a user whose copy holds no session any more, I sign out and no phone is told while the page still signs out', async () => {
    // Given a paired page whose copy holds no session
    const fakes = createHarness({ held: null });

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the page signs out and no phone or failure is counted
    expect(fakes.calls).toEqual(['reset', 'signed out']);
    expect(fakes.counted('wallet.logout')).toEqual([]);
  });

  it('As an operator, I see a sign-out whose copy cannot be read counted and the page still signs out', async () => {
    // Given a paired page whose copy cannot be read
    const fakes = createHarness();
    const failure = new Error('frame unreachable');
    fakes.copy.readFailure = failure;

    // When the user signs out
    const outcome = await fakes.signOut.signOut();

    // Then the phone cannot be told without the session, and the next load drops the copy by the rule. The read's
    // failure is core storage's to report.
    expect(outcome.phone).toBe('untold');
    expect(fakes.endSession).not.toHaveBeenCalled();
    expect(fakes.calls).toEqual(['reset', 'signed out']);
    expect(fakes.captures.exception).not.toHaveBeenCalled();
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'error', reason: 'read' }]);
  });

  it('As an operator, I see a session the phone could not be told about reported and let go and the page stays signed out', async () => {
    // Given a paired page whose core cannot end the session
    const fakes = createHarness();
    const failure = new Error('worker fatal error: boot');
    fakes.endSession.mockRejectedValue(failure);

    // When the user signs out twice
    const outcome = await fakes.signOut.signOut();
    await fakes.signOut.signOut();

    // Then the page keeps nothing to tell again, and a later sign-out ends nothing
    expect(outcome.phone).toBe('untold');
    expect(fakes.endSession).toHaveBeenCalledTimes(1);
    expect(fakes.reportSignedOut).toHaveBeenCalledTimes(2);
    expect(fakes.copy.held).toBeNull();
    expect(fakes.captures.exception).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        step: 'logout',
        tags: { reason: 'end' },
      }),
    );
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'error', reason: 'end' }]);
  });

  it('As a user in the sign-in window whose phone missed my sign-out, I tell it again and the same session is told once', async () => {
    // Given a sign-out the phone did not hear of, which let the copy go
    const fakes = createHarness();
    fakes.endSession.mockRejectedValueOnce(new Error('worker fatal error: boot'));
    const missed = await fakes.signOut.signOut();

    // When the phone is told again
    const again = missed.phone === 'untold' ? await fakes.signOut.tellAgain(missed) : missed;

    // Then it is told and the same session was ended twice
    expect(again).toEqual({ phone: 'told' });
    expect(fakes.endSession.mock.calls).toEqual([['0xsession'], ['0xsession']]);
  });

  it('As a user whose session was revoked on the phone so the core will not hold it, I sign out and the phone stays untold so I may try again', async () => {
    // Given a session the ending core cannot take, which looks like any other failure from here
    const fakes = createHarness();
    const failure = new Error('session does not decode');
    fakes.endSession.mockRejectedValue(failure);

    // When the user signs out and tells the phone again
    const outcome = await fakes.signOut.signOut();
    const again = outcome.phone === 'untold' ? await fakes.signOut.tellAgain(outcome) : outcome;

    // Then each try is reported, and the page is signed out
    expect(outcome.phone).toBe('untold');
    expect(again.phone).toBe('untold');
    expect(fakes.copy.held).toBeNull();
    expect(fakes.counted('wallet.logout')).toEqual([
      { outcome: 'error', reason: 'end' },
      { outcome: 'error', reason: 'end' },
    ]);
  });

  it('As a user whose copy could not be read, I tell the phone again and the copy is read again and what it holds ends', async () => {
    // Given a sign-out that missed a copy that can now be read
    const fakes = createHarness();
    fakes.copy.readFailure = new Error('frame unreachable');
    const missed = await fakes.signOut.signOut();
    fakes.copy.readFailure = null;

    // When the phone is told again
    const again = missed.phone === 'untold' ? await fakes.signOut.tellAgain(missed) : missed;

    // Then the copy's session is ended and the copy emptied
    expect(again).toEqual({ phone: 'told' });
    expect(fakes.endSession).toHaveBeenCalledWith('0xsession');
    expect(fakes.copy.held).toBeNull();
  });

  it('As a user, I press Sign out twice and the phone is told once', async () => {
    // Given a paired page holding a session in its copy
    const fakes = createHarness();

    // When the user signs out twice
    const outcomes = [await fakes.signOut.signOut(), await fakes.signOut.signOut()];

    // Then both answer told and the session was ended once
    expect(outcomes).toEqual([{ phone: 'told' }, { phone: 'told' }]);
    expect(fakes.endSession).toHaveBeenCalledTimes(1);
  });

  it('As an operator, I see a core that could not be reset reported, and the copy still goes and the phone is told', async () => {
    // Given a paired page whose core cannot be reset
    const fakes = createHarness();
    const failure = new Error('runtime disposed');
    fakes.resetSession.mockRejectedValue(failure);

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the copy goes, the phone is told and the reset failure is reported
    expect(fakes.copy.held).toBeNull();
    expect(fakes.endSession).toHaveBeenCalledWith('0xsession');
    expect(fakes.captures.exception).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        step: 'logout',
        tags: { reason: 'reset' },
      }),
    );
    expect(fakes.captures.exception).toHaveBeenCalledTimes(1);
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'ok' }]);
  });

  it('As an operator, I see a copy that could not be dropped reported once, and the phone is still told', async () => {
    // Given a paired page whose copy refuses the drop
    const fakes = createHarness();
    const failure = new Error('store refused the clear');
    fakes.copy.dropSessionIf.mockRejectedValue(failure);

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the phone is told, one issue is tagged drop and the sign-out counts once as ok
    expect(fakes.endSession).toHaveBeenCalledWith('0xsession');
    expect(fakes.captures.exception).toHaveBeenCalledTimes(1);
    expect(fakes.captures.exception).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        step: 'logout',
        tags: { reason: 'drop' },
      }),
    );
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'ok' }]);
  });

  it('As a user in paired mode, I sign out and no wait shows, since my page tells the phone itself', async () => {
    // Given a paired page holding a session in its copy
    const fakes = createHarness();

    // When the user signs out
    await fakes.signOut.signOut();

    // Then no wait was shown and local mode was not touched
    expect(fakes.signingOut).toEqual([]);
    expect(fakes.leaveLocalWallet).not.toHaveBeenCalled();
  });

  it('As a user in paired mode, I sign out and a visible check of the restore rule waits for my sign-out to end', async () => {
    // Given a sign-out whose end waits on the core, and a check queued behind it
    const coreFree = createDeferred<undefined>();
    const fakes = createHarness({ coreFree: coreFree.promise });
    const signOut = fakes.signOut.signOut();
    const checked: string[] = [];
    const check = fakes.signOuts.call(() => {
      checked.push(fakes.endSession.mock.calls.length === 0 ? 'before the sign-out' : 'after the sign-out');
      return Promise.resolve();
    });

    // When the core frees up
    coreFree.resolve(undefined);
    await Promise.all([signOut, check]);

    // Then the check ran after the sign-out
    expect(checked).toEqual(['after the sign-out']);
  });
});

describe('local sign-out', () => {
  it('As a user in local mode, I sign out and leave local mode once the sign-out window read the paired session left for it', async () => {
    // Given a sign-out window that has not read the main store yet
    const read = createDeferred<undefined>();
    const fakes = createHarness({ local: true, signOutWindow: createProductWindow(read.promise) });

    // When the user signs out and the window then reads
    const signOut = fakes.signOut.signOut();
    await fakes.changes.until(() => fakes.signingOut.length === 1);
    const leftBeforeRead = fakes.leaveLocalWallet.mock.calls.length;
    read.resolve(undefined);
    await signOut;

    // Then the page waited for the window, then left local mode with its wallet, and the reload's restore rule takes
    // the copy
    expect(leftBeforeRead).toBe(0);
    expect(fakes.calls).toEqual(['leave local', 'forget wallet']);
    expect(fakes.copy.readSession).not.toHaveBeenCalled();
  });

  it('As a user in local mode, I sign out and the page shows my sign-out pending while the sign-out window reads', async () => {
    // Given a local page whose sign-out window has not read yet
    const read = createDeferred<undefined>();
    const fakes = createHarness({ local: true, signOutWindow: createProductWindow(read.promise) });

    // When the user signs out, and the window then reads
    const signOut = fakes.signOut.signOut();
    await fakes.changes.until(() => fakes.signingOut.length === 1);
    const whileReading = [...fakes.signingOut];
    read.resolve(undefined);
    await signOut;

    // Then the page showed the sign-out pending, and the pending sign-out ends
    expect(whileReading).toEqual([true]);
    expect(fakes.signingOut).toEqual([true, false]);
  });

  it('As a user in local mode, I sign out and a visible check of the restore rule waits for my sign-out to end', async () => {
    // Given a sign-out waiting for the window to read the paired copy, and a check queued behind it
    const read = createDeferred<undefined>();
    const fakes = createHarness({ local: true, signOutWindow: createProductWindow(read.promise) });
    const signOut = fakes.signOut.signOut();
    const checked: string[] = [];
    const check = fakes.signOuts.call(() => {
      checked.push(fakes.leaveLocalWallet.mock.calls.length === 0 ? 'before the sign-out' : 'after the sign-out');
      return Promise.resolve();
    });
    await fakes.changes.until(() => fakes.signingOut.length === 1);

    // When the window has read
    read.resolve(undefined);
    await Promise.all([signOut, check]);

    // Then the check ran only once the sign-out had left local mode
    expect(checked).toEqual(['after the sign-out']);
  });

  it('As a user in local mode, I press Sign out and my sign-out waits on the window open at that moment, not on one opened later', async () => {
    // Given a sign-out window that has not read yet, which the page's handoff gives until a later click opens another
    const firstRead = createDeferred<undefined>();
    const reads: string[] = [];
    let open = 'first';
    function openSignOutWindow() {
      const asked = open;
      return {
        signOutRead() {
          reads.push(asked);
          return asked === 'first' ? firstRead.promise : Promise.resolve(undefined);
        },
      };
    }
    const fakes = createHarness({ local: true, signOutWindow: openSignOutWindow });

    // When I sign out, another window opens before my sign-out runs, and the first window reads
    const signOut = fakes.signOut.signOut();
    open = 'later';
    firstRead.resolve(undefined);
    await signOut;

    // Then my sign-out asked only the first window, and left local mode once it read
    expect(reads).toEqual(['first']);
    expect(fakes.calls).toEqual(['leave local', 'forget wallet']);
  });

  it('As a user in local mode whose sign-out window never reads, I sign out and nothing on the core is held up', async () => {
    // Given a local page whose sign-out window never reads
    const fakes = createHarness({
      local: true,
      signOutWindow: createProductWindow(new Promise<void>(() => undefined)),
    });

    // When the user signs out
    void fakes.signOut.signOut();
    await fakes.changes.until(() => fakes.signingOut.length === 1);

    // Then the core commands, and the logins they queue, never heard of it
    expect(fakes.runOnCore).not.toHaveBeenCalled();
  });

  it('As a user in local mode whose flag cannot be read, I sign out and the paired copy goes before the wallet', async () => {
    // Given no restore rule would clear the copy on the reload
    const fakes = createHarness({ local: true, flag: 'unknown' });

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the copy goes by itself, since the flag it would move is unknown
    expect(fakes.calls).toEqual(['drop 0xsession', 'leave local', 'forget wallet']);
    expect(fakes.countFlagClears()).toBe(0);
    expect(fakes.endSession).not.toHaveBeenCalled();
  });

  it('As a user signing out locally on a product whose flag is unreadable, I see a copy that cannot be read counted once and not captured again', async () => {
    // Given a copy whose read fails, which core storage already reported
    const fakes = createHarness({ local: true, flag: 'unknown' });
    fakes.copy.readFailure = new Error('frame unreachable');

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the failed read is counted once and no defect is captured
    expect(fakes.captures.exception).not.toHaveBeenCalled();
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'error', reason: 'drop' }]);
  });

  it('As a user in local mode signed in again elsewhere meanwhile, I sign out and the paired copy stays', async () => {
    // Given a local page whose flag is present again
    const fakes = createHarness({ local: true, flag: 'present' });

    // When the user signs out
    await fakes.signOut.signOut();

    // Then only the wallet goes
    expect(fakes.calls).toEqual(['leave local', 'forget wallet']);
  });

  it('As a user in local mode on a product whose other tab imports a wallet while the sign-out window reads, I sign out and that wallet stays', async () => {
    // Given a local sign-out waiting on its window's read
    const read = createDeferred<undefined>();
    const fakes = createHarness({ local: true, signOutWindow: createProductWindow(read.promise) });
    const signOut = fakes.signOut.signOut();
    await fakes.changes.until(() => fakes.signingOut.length === 1);

    // When another tab saves a wallet and the window then reads
    saveElsewhere(fakes.wallet);
    read.resolve(undefined);
    await signOut;

    // Then only the wallet my sign-out read could go
    expect(fakes.calls).toEqual(['leave local']);
    expect(fakes.wallet.version).toBe(2);
  });

  it('As a user in local mode on a page with no sign-in window whose other tab imports a wallet meanwhile, I sign out and that wallet stays', async () => {
    // Given a local page with no window whose copy read lets another tab save a wallet
    const fakes = createHarness({ local: true, held: null, signOutWindow: openNoWindow });
    fakes.copy.readSession.mockImplementationOnce(() => {
      saveElsewhere(fakes.wallet);
      return Promise.resolve({ status: 'ok', blob: null });
    });

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the page leaves local mode and the newer wallet stays
    expect(fakes.calls).toEqual(['leave local']);
    expect(fakes.wallet.version).toBe(2);
  });

  it('As a user in local mode whose wallet cannot be read, I sign out and nothing is forgotten while the switch reports why', async () => {
    // Given a local page whose wallet cannot be read
    const fakes = createHarness({ local: true });
    const failure = new Error('frame unavailable');
    fakes.wallet.readFailure = failure;
    let forgetFailure: unknown;
    fakes.leaveLocalWallet.mockImplementationOnce(async forget => {
      fakes.calls.push('leave local');
      await forget().catch((error: unknown) => {
        forgetFailure = error;
      });
      return 'failed';
    });

    // When the user signs out
    await fakes.signOut.signOut();

    // Then no wallet is forgotten and the forget fails with the read as its cause
    expect(fakes.calls).toEqual(['leave local']);
    expect(fakes.wallet.version).toBe(1);
    expect(forgetFailure).toEqual(expect.objectContaining({ cause: failure }));
  });

  it('As an operator, I see a local sign-out whose paired copy stays reported and it still leaves local mode', async () => {
    // Given a local page whose flag reads unknown and whose copy refuses the drop
    const fakes = createHarness({ local: true, flag: 'unknown' });
    const failure = new Error('store refused the clear');
    fakes.copy.dropSessionIf.mockRejectedValue(failure);

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the failed drop is reported and the page still leaves local mode
    expect(fakes.captures.exception).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        step: 'logout',
        tags: { reason: 'drop' },
      }),
    );
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'error', reason: 'drop' }]);
    expect(fakes.leaveLocalWallet).toHaveBeenCalledTimes(1);
  });

  it('As a user in local mode on a page with no sign-in window, I sign out and my paired copy and wallet go through the flag keeper while the phone is reported untold', async () => {
    // Given a local page with no sign-in window
    const fakes = createHarness({ local: true, signOutWindow: openNoWindow });

    // When the user signs out
    const outcome = await fakes.signOut.signOut();

    // Then the copy and the wallet go through the flag and the phone is counted untold
    expect(fakes.calls).toEqual(['drop 0xsession', 'leave local', 'forget wallet']);
    expect(fakes.countFlagClears()).toBe(2);
    expect(fakes.endSession).not.toHaveBeenCalled();
    expect(outcome.phone).toBe('untold');
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'error', reason: 'no_window' }]);
  });

  it('As a user in local mode on a page with no sign-in window, I tell the phone again and it stays untold with nothing ended', async () => {
    // Given a local sign-out on a page with no sign-in window, which left the phone untold
    const fakes = createHarness({ local: true, signOutWindow: openNoWindow });
    const missed = await fakes.signOut.signOut();

    // When the phone is told again
    const again = missed.phone === 'untold' ? await fakes.signOut.tellAgain(missed) : missed;

    // Then it stays untold and nothing more is ended or dropped
    expect(again).toEqual(missed);
    expect(fakes.endSession).not.toHaveBeenCalled();
    expect(fakes.calls).toEqual(['drop 0xsession', 'leave local', 'forget wallet']);
  });

  it('As a user in local mode on a page with no sign-in window and no paired copy, I sign out and my wallet goes through the flag keeper with nothing to tell', async () => {
    // Given a local page with no sign-in window and an empty copy
    const fakes = createHarness({ local: true, held: null, signOutWindow: openNoWindow });

    // When the user signs out
    const outcome = await fakes.signOut.signOut();

    // Then the wallet goes through the flag and nothing is counted
    expect(fakes.calls).toEqual(['leave local', 'forget wallet']);
    expect(fakes.countFlagClears()).toBe(1);
    expect(outcome).toEqual({ phone: 'told' });
    expect(fakes.counted('wallet.logout')).toEqual([]);
  });

  it('As an operator, I see a local sign-out in place whose paired copy could not be dropped reported and counted once, and the wallet still goes', async () => {
    // Given a local page with no sign-in window whose copy refuses the drop
    const fakes = createHarness({ local: true, signOutWindow: openNoWindow });
    const failure = new Error('store refused the clear');
    fakes.copy.dropSessionIf.mockRejectedValue(failure);

    // When the user signs out
    const outcome = await fakes.signOut.signOut();

    // Then the failed drop is reported and counted once
    expect(fakes.captures.exception).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        step: 'logout',
        tags: { reason: 'drop' },
      }),
    );
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'error', reason: 'drop' }]);
    expect(fakes.calls).toEqual(['leave local', 'forget wallet']);
    expect(outcome.phone).toBe('untold');
  });

  it('As a user in local mode on a page with no sign-in window whose copy cannot be read, I sign out and my wallet still goes while the phone is reported untold', async () => {
    // Given a local page with no sign-in window whose copy cannot be read
    const fakes = createHarness({ local: true, signOutWindow: openNoWindow });
    fakes.copy.readFailure = new Error('frame unavailable');

    // When the user signs out
    const outcome = await fakes.signOut.signOut();

    // Then the wallet goes and the phone is counted untold
    expect(fakes.calls).toEqual(['leave local', 'forget wallet']);
    expect(outcome.phone).toBe('untold');
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'error', reason: 'read' }]);
  });

  it('As a local wallet user whose switch back failed, I sign out with no session ended and nothing counted', async () => {
    // Given a switch that reports its own failure and answers failed
    const fakes = createHarness({ local: true, leaveOutcome: 'failed' });

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the switch's report is the only one
    expect(fakes.calls).toEqual(['leave local']);
    expect(fakes.counted('wallet.logout')).toEqual([]);
    expect(fakes.captures.exception).not.toHaveBeenCalled();
  });

  it('As a user in local mode, I sign out and my sign-out runs its end through the core commands after the window read', async () => {
    // Given a local page
    const fakes = createHarness({ local: true });

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the core commands ran once, before the page left local mode
    expect(fakes.runOnCore).toHaveBeenCalledTimes(1);
    expect(nth(fakes.runOnCore.mock.invocationCallOrder, 0)).toBeLessThan(
      nth(fakes.leaveLocalWallet.mock.invocationCallOrder, 0),
    );
  });
});

describe('sign-out on a page signed out elsewhere', () => {
  it('As a user in a paired tab whose flag is gone, I am signed out without clearing anything myself and no core boots', async () => {
    // Given a copy the restore rule already cleared
    const fakes = createHarness({ held: null });

    // When the page signs out locally
    await fakes.signOut.signOutLocally();

    // Then the core resets and the page shows signed out with no core booted
    expect(fakes.calls).toEqual(['reset', 'signed out']);
    expect(fakes.runOnCore).not.toHaveBeenCalled();
  });

  it('As a local wallet user in a tab whose wallet a sign-out elsewhere forgot, I leave local mode and forget nothing', async () => {
    // Given a wallet another tab imported since the watch found mine gone
    const fakes = createHarness({ local: true, wallet: 2 });

    // When the page signs out locally
    await fakes.signOut.signOutLocally();

    // Then the page leaves local mode and the newer wallet stays
    expect(fakes.calls).toEqual(['leave local']);
    expect(fakes.wallet.version).toBe(2);
  });

  it('As a local wallet user in a tab whose wallet cannot be forgotten, I am signed out locally and the sign-out rejects', async () => {
    // Given a local page whose switch back fails
    const fakes = createHarness({ local: true, leaveOutcome: 'failed' });

    // When the page signs out locally
    const error = await catchRejection(fakes.signOut.signOutLocally());

    // Then the sign-out rejects
    expect(error.message).toContain('The local wallet could not be forgotten');
  });
});

describe('signed-in sites on sign-out', () => {
  it('As a user in paired mode, I sign out and my signed-in sites are forgotten once my page let the session go', async () => {
    // Given a paired page holding a session in its copy
    const fakes = createHarness();

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the grants were forgotten once, after the cores let the session go
    expect(fakes.forgetGrants).toHaveBeenCalledTimes(1);
    expect(nth(fakes.resetSession.mock.invocationCallOrder, 0)).toBeLessThan(
      nth(fakes.forgetGrants.mock.invocationCallOrder, 0),
    );
  });

  it('As a user in paired mode whose copy cannot be read, I sign out and my signed-in sites are still forgotten', async () => {
    // Given a paired page whose copy cannot be read
    const fakes = createHarness();
    fakes.copy.readFailure = new Error('frame unreachable');

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the sign-in ended, and the grants with it
    expect(fakes.forgetGrants).toHaveBeenCalledTimes(1);
  });

  it('As a user in local mode on a product, I sign out and my signed-in sites are forgotten before the page reloads', async () => {
    // Given a local product page whose sign-out window read the main store
    const fakes = createHarness({ local: true });

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the grants were forgotten once, before the page left local mode
    expect(fakes.forgetGrants).toHaveBeenCalledTimes(1);
    expect(nth(fakes.forgetGrants.mock.invocationCallOrder, 0)).toBeLessThan(
      nth(fakes.leaveLocalWallet.mock.invocationCallOrder, 0),
    );
  });

  it('As a user in local mode on a page with no sign-in window, I sign out and my signed-in sites are forgotten before the page reloads', async () => {
    // Given a local page that pairs in place
    const fakes = createHarness({ local: true, signOutWindow: openNoWindow });

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the grants were forgotten once, before the page left local mode
    expect(fakes.forgetGrants).toHaveBeenCalledTimes(1);
    expect(nth(fakes.forgetGrants.mock.invocationCallOrder, 0)).toBeLessThan(
      nth(fakes.leaveLocalWallet.mock.invocationCallOrder, 0),
    );
  });

  it('As an operator, I watch a paired sign-out whose grants could not be forgotten and see it reported while the phone is still told', async () => {
    // Given a paired page whose grants cannot be forgotten
    const fakes = createHarness();
    const failure = new Error('grants database blocked');
    fakes.forgetGrants.mockRejectedValue(failure);

    // When the user signs out
    const outcome = await fakes.signOut.signOut();

    // Then the failure is reported under its own reason and counted as a forget that failed, and the sign-out ends as
    // it would have
    expect(fakes.captures.exception).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        step: 'logout',
        tags: { reason: 'grants' },
      }),
    );
    expect(fakes.counted('session_pages.site_revoke')).toEqual([{ outcome: 'error', reason: 'sign_out' }]);
    expect(outcome).toEqual({ phone: 'told' });
    expect(fakes.calls).toEqual(['reset', 'drop 0xsession', 'signed out', 'end 0xsession']);
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'ok' }]);
  });

  it('As a user in a tab signed out elsewhere, I am signed out locally and the signed-in sites are left to the sign-out that ended the sign-in', async () => {
    // Given a paired tab whose copy the restore rule already cleared
    const fakes = createHarness({ held: null });

    // When the page signs out locally
    await fakes.signOut.signOutLocally();

    // Then nothing here forgets the grants
    expect(fakes.forgetGrants).not.toHaveBeenCalled();
  });
});
