// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { createAsyncTaskPool, createSyncStore, type AsyncTaskPool } from '@dotli/shared';
import { nth } from '@dotli/shared/testing';
import { createAuthCommands } from './core-login.js';
import type { DotliAuthState } from './session/auth-state.js';
import type { SessionRead } from './session/core-storage.js';
import type { Presence } from './session/presence.js';
import { createFakeSessionPresence } from './session/presence.fake.js';
import { createPageSignOut, type PageSignOut, type PageSignOutDeps } from './sign-out.js';
import type { WalletMode } from './state/wallet-mode.js';
import type { WalletSwitchOutcome } from './wallet-switch.js';
import { createChanges, type Changes } from '../testing/changes.js';

/** The page's copy of the paired session, which the window's restore rule or a visible check may clear meanwhile. */
interface FakeCopy {
  held: string | null;
  /** While set, every read answers it. */
  readFailure: Error | null;
  readSession: ReturnType<typeof vi.fn<() => Promise<SessionRead>>>;
  dropSessionIf: ReturnType<typeof vi.fn<(blob: string) => Promise<boolean>>>;
}

/** Records each drop in `calls`. */
function fakeCopy(held: string | null, calls: string[]): FakeCopy {
  const copy: FakeCopy = {
    held,
    readFailure: null,
    readSession: vi.fn(() =>
      Promise.resolve<SessionRead>(
        copy.readFailure === null ? { status: 'ok', blob: copy.held } : { status: 'failed', error: copy.readFailure },
      ),
    ),
    dropSessionIf: vi.fn((blob: string) => {
      calls.push(`drop ${blob}`);
      if (copy.held !== blob) {
        return Promise.resolve(false);
      }
      copy.held = null;
      return Promise.resolve(true);
    }),
  };
  return copy;
}

type OnCore = <T>(end: () => Promise<T>) => Promise<T>;

/** The main store's local wallet, whose record a save elsewhere replaces with a new version. */
interface FakeWallet {
  version: number | null;
  /** While set, every read rejects with it. */
  readFailure: Error | null;
}

/** The wallet record another tab saves, a new version of whatever it holds. */
function saveElsewhere(wallet: FakeWallet): void {
  wallet.version = (wallet.version ?? 0) + 1;
}

interface Harness {
  signOut: PageSignOut;
  copy: FakeCopy;
  /** Each clear the flag keeper ran. */
  flagClears: number;
  endSession: ReturnType<typeof vi.fn<(blob: string) => Promise<void>>>;
  resetSession: ReturnType<typeof vi.fn<() => Promise<void>>>;
  reportSignedOut: ReturnType<typeof vi.fn<() => void>>;
  leaveLocalWallet: ReturnType<typeof vi.fn<(forget: () => Promise<void>) => Promise<WalletSwitchOutcome>>>;
  wallet: FakeWallet;
  signOuts: AsyncTaskPool;
  /** Each end the sign-out ran through the core commands. */
  onCore: ReturnType<typeof vi.fn<() => void>>;
  /** Each status the sign-out reported, in order. */
  signingOut: boolean[];
  /** Every call the sign-out made on the cores, the phone and the copy, in order. */
  calls: string[];
  changes: Changes;
  captures: { exception: ReturnType<typeof vi.fn>; expected: ReturnType<typeof vi.fn> };
  counted: RecordingSentry['counted'];
}

/** A page's sign-out over fakes, with a fake Sentry and capture sink bound for this test. */
function harness(
  options: {
    walletMode?: WalletMode;
    /** The paired session the page's copy holds, one by default. */
    held?: string | null;
    /** The signed-in flag as a local sign-out reads it, gone by default, as the sign-out deleted it. */
    flag?: Presence;
    leaveOutcome?: WalletSwitchOutcome;
    /** The local wallet's record version in the main store, one by default, null for none. */
    wallet?: number | null;
    /** Runs a sign-out's end on the core once this settles, as a login still open holds it. */
    coreFree?: Promise<void>;
    /** The core commands' logout, a passthrough by default. */
    onCore?: OnCore;
    /** A product's sign-out window that already read the paired session by default. */
    signOutWindow?: PageSignOutDeps['signOutWindow'];
  } = {},
): Harness {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const captures = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));
  const changes = createChanges();
  const calls: string[] = [];
  const copy = fakeCopy(options.held === undefined ? '0xsession' : options.held, calls);
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
  const wallet: FakeWallet = { version: options.wallet === undefined ? 1 : options.wallet, readFailure: null };
  // Runs the `forget` it is given before it answers.
  const leaveLocalWallet = vi.fn(async (forget: () => Promise<void>) => {
    calls.push('leave local');
    if (options.leaveOutcome === 'failed') {
      return 'failed';
    }
    await forget();
    return 'reloading';
  });
  const signOuts = createAsyncTaskPool({ poolSize: 1 });
  // A spy of its own, since a mock does not keep the logout's type parameter.
  const coreRun = vi.fn<() => void>();
  const onCore: OnCore = async end => {
    coreRun();
    await options.coreFree;
    return options.onCore === undefined ? end() : options.onCore(end);
  };
  const signingOut: boolean[] = [];
  const fakes: Harness = {
    signOut: createPageSignOut({
      walletMode: () => options.walletMode ?? 'app',
      copy,
      flag: {
        clear: async clear => {
          fakes.flagClears += 1;
          return (await clear?.()) ?? false;
        },
      },
      endSession,
      cores: { resetSession },
      session: { reportSignedOut },
      leaveLocalWallet,
      wallet: {
        read: () => {
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
        forgetIf: version => {
          const holds = wallet.version === version[0];
          if (holds) {
            calls.push('forget wallet');
            wallet.version = null;
          }
          return Promise.resolve(holds);
        },
      },
      presence: createFakeSessionPresence(options.flag ?? 'absent'),
      reportSigningOut: pending => {
        signingOut.push(pending);
        changes.notify();
      },
      signOutWindow: options.signOutWindow ?? productWindow(Promise.resolve()),
      signOuts,
      onCore,
    }),
    copy,
    flagClears: 0,
    endSession,
    resetSession,
    reportSignedOut,
    leaveLocalWallet,
    wallet,
    signOuts,
    onCore: coreRun,
    signingOut,
    calls,
    changes,
    captures,
    counted: metrics.counted,
  };
  return fakes;
}

/** A product's sign-out window, which tells the phone and whose read settles with `read`. */
function productWindow(read: Promise<void>): PageSignOutDeps['signOutWindow'] {
  return () => ({ signOutRead: () => read });
}

/** A page that pairs in place, which has no sign-out window, so nothing tells the phone in local mode. */
const NO_WINDOW: PageSignOutDeps['signOutWindow'] = () => null;

describe('paired sign-out', () => {
  it('As a user in paired mode, I sign out and my cores and copy let the session go, which a core of my own then ends on the phone', async () => {
    // Given a paired page holding a session in its copy
    const fakes = harness();

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the page lets go first, since it holds the session itself, and the phone is told about the session it held
    expect(fakes.calls).toEqual(['reset', 'drop 0xsession', 'signed out', 'end 0xsession']);
    expect(fakes.copy.held).toBeNull();
    expect(fakes.flagClears).toBe(1);
    expect(fakes.onCore).toHaveBeenCalledTimes(1);
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'ok' }]);
    expect(fakes.captures.exception).not.toHaveBeenCalled();
  });

  it('As a user on a product page in a browser that shares the main store, I sign out after the sign-out window cleared that store and the phone is still told about my session', async () => {
    // Given a login still open, so the sign-out's end on the core waits on a core that still boots
    const coreFree = Promise.withResolvers<undefined>();
    const fakes = harness({ coreFree: coreFree.promise });

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
    const coreFree = Promise.withResolvers<undefined>();
    const fakes = harness({ coreFree: coreFree.promise });
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
    const fakes = harness({ held: null });

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the page signs out and no phone or failure is counted
    expect(fakes.calls).toEqual(['reset', 'signed out']);
    expect(fakes.counted('wallet.logout')).toEqual([]);
  });

  it('As an operator, I see a sign-out whose copy cannot be read counted and the page still signs out', async () => {
    // Given a paired page whose copy cannot be read
    const fakes = harness();
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
    const fakes = harness();
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
    expect(fakes.captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'wallet',
      step: 'logout',
      tags: { reason: 'end' },
    });
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'error', reason: 'end' }]);
  });

  it('As a user in the sign-in window whose phone missed my sign-out, I tell it again and the same session is told once', async () => {
    // Given a sign-out the phone did not hear of, which let the copy go
    const fakes = harness();
    fakes.endSession.mockRejectedValueOnce(new Error('worker fatal error: boot'));
    const missed = await fakes.signOut.signOut();

    // When the phone is told again
    const again = missed.phone === 'untold' ? await missed.tellAgain() : missed;

    // Then it is told and the same session was ended twice
    expect(again).toEqual({ phone: 'told' });
    expect(fakes.endSession.mock.calls).toEqual([['0xsession'], ['0xsession']]);
  });

  it('As a user whose session was revoked on the phone so the core will not hold it, I sign out and the phone stays untold so I may try again', async () => {
    // Given a session the ending core cannot take, which looks like any other failure from here
    const fakes = harness();
    const failure = new Error('session does not decode');
    fakes.endSession.mockRejectedValue(failure);

    // When the user signs out and tells the phone again
    const outcome = await fakes.signOut.signOut();
    const again = outcome.phone === 'untold' ? await outcome.tellAgain() : outcome;

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
    const fakes = harness();
    fakes.copy.readFailure = new Error('frame unreachable');
    const missed = await fakes.signOut.signOut();
    fakes.copy.readFailure = null;

    // When the phone is told again
    const again = missed.phone === 'untold' ? await missed.tellAgain() : missed;

    // Then the copy's session is ended and the copy emptied
    expect(again).toEqual({ phone: 'told' });
    expect(fakes.endSession).toHaveBeenCalledWith('0xsession');
    expect(fakes.copy.held).toBeNull();
  });

  it('As a user, I press Sign out twice and the phone is told once', async () => {
    // Given a paired page holding a session in its copy
    const fakes = harness();

    // When the user signs out twice
    const outcomes = [await fakes.signOut.signOut(), await fakes.signOut.signOut()];

    // Then both answer told and the session was ended once
    expect(outcomes).toEqual([{ phone: 'told' }, { phone: 'told' }]);
    expect(fakes.endSession).toHaveBeenCalledTimes(1);
  });

  it('As a user whose core reads signed out once the window cleared the store, I sign out and the session my copy held is still ended', async () => {
    // Given the core commands over a core that already reports signed out
    const auth = createSyncStore<DotliAuthState>('auth', { tag: 'Disconnected' });
    const commands = createAuthCommands({
      auth,
      login: () => Promise.resolve({ kind: 'cancelled' }),
      cancelPairing: () => undefined,
    });
    const fakes = harness({ onCore: end => commands.logout(end) });

    // When the user signs out
    const outcome = await fakes.signOut.signOut();

    // Then the phone is told about the session the copy held
    expect(outcome).toEqual({ phone: 'told' });
    expect(fakes.endSession).toHaveBeenCalledWith('0xsession');
  });

  it('As an operator, I see a core that could not be reset reported, and the copy still goes and the phone is told', async () => {
    // Given a paired page whose core cannot be reset
    const fakes = harness();
    const failure = new Error('runtime disposed');
    fakes.resetSession.mockRejectedValue(failure);

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the copy goes, the phone is told and the reset failure is reported
    expect(fakes.copy.held).toBeNull();
    expect(fakes.endSession).toHaveBeenCalledWith('0xsession');
    expect(fakes.captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'wallet',
      step: 'logout',
      tags: { reason: 'reset' },
    });
    expect(fakes.captures.exception).toHaveBeenCalledTimes(1);
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'ok' }]);
  });

  it('As an operator, I see a copy that could not be dropped reported once, and the phone is still told', async () => {
    // Given a paired page whose copy refuses the drop
    const fakes = harness();
    const failure = new Error('store refused the clear');
    fakes.copy.dropSessionIf.mockRejectedValue(failure);

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the phone is told, one issue is tagged drop and the sign-out counts once as ok
    expect(fakes.endSession).toHaveBeenCalledWith('0xsession');
    expect(fakes.captures.exception).toHaveBeenCalledTimes(1);
    expect(fakes.captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'wallet',
      step: 'logout',
      tags: { reason: 'drop' },
    });
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'ok' }]);
  });

  it('As a user in paired mode, I sign out and no wait shows, since my page tells the phone itself', async () => {
    // Given a paired page holding a session in its copy
    const fakes = harness();

    // When the user signs out
    await fakes.signOut.signOut();

    // Then no wait was shown and local mode was not touched
    expect(fakes.signingOut).toEqual([]);
    expect(fakes.leaveLocalWallet).not.toHaveBeenCalled();
  });

  it('As a user in paired mode, I sign out and a visible check of the restore rule waits for my sign-out to end', async () => {
    // Given a sign-out whose end waits on the core, and a check queued behind it
    const coreFree = Promise.withResolvers<undefined>();
    const fakes = harness({ coreFree: coreFree.promise });
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
  it('As a user in local mode, I leave local mode once the sign-out window read the paired session, left for it', async () => {
    // Given a sign-out window that has not read the main store yet
    const read = Promise.withResolvers<undefined>();
    const fakes = harness({ walletMode: 'local', signOutWindow: productWindow(read.promise) });

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
    const read = Promise.withResolvers<undefined>();
    const fakes = harness({ walletMode: 'local', signOutWindow: productWindow(read.promise) });

    // When the user signs out
    const signOut = fakes.signOut.signOut();
    await fakes.changes.until(() => fakes.signingOut.length === 1);

    // Then the page shows the sign-out pending
    expect(fakes.signingOut).toEqual([true]);

    // When the window reads
    read.resolve(undefined);
    await signOut;

    // Then the pending sign-out ends
    expect(fakes.signingOut).toEqual([true, false]);
  });

  it('As a user in local mode, I sign out and a visible check of the restore rule waits for my sign-out to end', async () => {
    // Given a sign-out waiting for the window to read the paired copy, and a check queued behind it
    const read = Promise.withResolvers<undefined>();
    const fakes = harness({ walletMode: 'local', signOutWindow: productWindow(read.promise) });
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
    const firstRead = Promise.withResolvers<undefined>();
    const reads: string[] = [];
    let open = 'first';
    const signOutWindow: PageSignOutDeps['signOutWindow'] = () => {
      const asked = open;
      return {
        signOutRead: () => {
          reads.push(asked);
          return asked === 'first' ? firstRead.promise : Promise.resolve();
        },
      };
    };
    const fakes = harness({ walletMode: 'local', signOutWindow });

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
    const fakes = harness({ walletMode: 'local', signOutWindow: productWindow(new Promise<void>(() => undefined)) });

    // When the user signs out
    void fakes.signOut.signOut();
    await fakes.changes.until(() => fakes.signingOut.length === 1);

    // Then the core commands, and the logins they queue, never heard of it
    expect(fakes.onCore).not.toHaveBeenCalled();
  });

  it('As a user in local mode whose flag cannot be read, I sign out and the paired copy goes before the wallet', async () => {
    // Given no restore rule would clear the copy on the reload
    const fakes = harness({ walletMode: 'local', flag: 'unknown' });

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the copy goes by itself, since the flag it would move is unknown
    expect(fakes.calls).toEqual(['drop 0xsession', 'leave local', 'forget wallet']);
    expect(fakes.flagClears).toBe(0);
    expect(fakes.endSession).not.toHaveBeenCalled();
  });

  it('As a user in local mode signed in again elsewhere meanwhile, I sign out and the paired copy stays', async () => {
    // Given a local page whose flag is present again
    const fakes = harness({ walletMode: 'local', flag: 'present' });

    // When the user signs out
    await fakes.signOut.signOut();

    // Then only the wallet goes
    expect(fakes.calls).toEqual(['leave local', 'forget wallet']);
  });

  it('As a user in local mode on a product whose other tab imports a wallet while the sign-out window reads, I sign out and that wallet stays', async () => {
    // Given a local sign-out waiting on its window's read
    const read = Promise.withResolvers<undefined>();
    const fakes = harness({ walletMode: 'local', signOutWindow: productWindow(read.promise) });
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
    const fakes = harness({ walletMode: 'local', held: null, signOutWindow: NO_WINDOW });
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
    const fakes = harness({ walletMode: 'local' });
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
    const fakes = harness({ walletMode: 'local', flag: 'unknown' });
    const failure = new Error('store refused the clear');
    fakes.copy.dropSessionIf.mockRejectedValue(failure);

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the failed drop is reported and the page still leaves local mode
    expect(fakes.captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'wallet',
      step: 'logout',
      tags: { reason: 'drop' },
    });
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'error', reason: 'drop' }]);
    expect(fakes.leaveLocalWallet).toHaveBeenCalledTimes(1);
  });

  it('As a user in local mode on a page with no sign-in window, I sign out and my paired copy and wallet go through the flag keeper while the phone is reported untold', async () => {
    // Given a local page with no sign-in window
    const fakes = harness({ walletMode: 'local', signOutWindow: NO_WINDOW });

    // When the user signs out
    const outcome = await fakes.signOut.signOut();

    // Then the copy and the wallet go through the flag and the phone is counted untold
    expect(fakes.calls).toEqual(['drop 0xsession', 'leave local', 'forget wallet']);
    expect(fakes.flagClears).toBe(2);
    expect(fakes.endSession).not.toHaveBeenCalled();
    expect(outcome.phone).toBe('untold');
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'error', reason: 'no_window' }]);
  });

  it('As a user in local mode on a page with no sign-in window and no paired copy, I sign out and my wallet goes through the flag keeper with nothing to tell', async () => {
    // Given a local page with no sign-in window and an empty copy
    const fakes = harness({ walletMode: 'local', held: null, signOutWindow: NO_WINDOW });

    // When the user signs out
    const outcome = await fakes.signOut.signOut();

    // Then the wallet goes through the flag and nothing is counted
    expect(fakes.calls).toEqual(['leave local', 'forget wallet']);
    expect(fakes.flagClears).toBe(1);
    expect(outcome).toEqual({ phone: 'told' });
    expect(fakes.counted('wallet.logout')).toEqual([]);
  });

  it('As an operator, I see a local sign-out in place whose paired copy could not be dropped reported and counted once, and the wallet still goes', async () => {
    // Given a local page with no sign-in window whose copy refuses the drop
    const fakes = harness({ walletMode: 'local', signOutWindow: NO_WINDOW });
    const failure = new Error('store refused the clear');
    fakes.copy.dropSessionIf.mockRejectedValue(failure);

    // When the user signs out
    const outcome = await fakes.signOut.signOut();

    // Then the failed drop is reported and counted once
    expect(fakes.captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'wallet',
      step: 'logout',
      tags: { reason: 'drop' },
    });
    expect(fakes.counted('wallet.logout')).toEqual([{ outcome: 'error', reason: 'drop' }]);
    expect(fakes.calls).toEqual(['leave local', 'forget wallet']);
    expect(outcome.phone).toBe('untold');
  });

  it('As a user in local mode on a page with no sign-in window whose copy cannot be read, I sign out and my wallet still goes while the phone is reported untold', async () => {
    // Given a local page with no sign-in window whose copy cannot be read
    const fakes = harness({ walletMode: 'local', signOutWindow: NO_WINDOW });
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
    const fakes = harness({ walletMode: 'local', leaveOutcome: 'failed' });

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the switch's report is the only one
    expect(fakes.calls).toEqual(['leave local']);
    expect(fakes.counted('wallet.logout')).toEqual([]);
    expect(fakes.captures.exception).not.toHaveBeenCalled();
  });

  it('As a user in local mode, I sign out and my sign-out runs its end through the core commands after the window read', async () => {
    // Given a local page
    const fakes = harness({ walletMode: 'local' });

    // When the user signs out
    await fakes.signOut.signOut();

    // Then the core commands ran once, before the page left local mode
    expect(fakes.onCore).toHaveBeenCalledTimes(1);
    expect(nth(fakes.onCore.mock.invocationCallOrder, 0)).toBeLessThan(
      nth(fakes.leaveLocalWallet.mock.invocationCallOrder, 0),
    );
  });
});

describe('sign-out on a page signed out elsewhere', () => {
  it('As a paired tab whose flag is gone, I am signed out without clearing anything myself, booting no core', async () => {
    // Given a copy the restore rule already cleared
    const fakes = harness({ held: null });

    // When the page signs out locally
    await fakes.signOut.signOutLocally();

    // Then the core resets and the page shows signed out with no core booted
    expect(fakes.calls).toEqual(['reset', 'signed out']);
    expect(fakes.onCore).not.toHaveBeenCalled();
  });

  it('As a local wallet tab whose wallet a sign-out elsewhere forgot, I leave local mode and forget nothing', async () => {
    // Given a wallet another tab imported since the watch found mine gone
    const fakes = harness({ walletMode: 'local', wallet: 2 });

    // When the page signs out locally
    await fakes.signOut.signOutLocally();

    // Then the page leaves local mode and the newer wallet stays
    expect(fakes.calls).toEqual(['leave local']);
    expect(fakes.wallet.version).toBe(2);
  });

  it('As a local wallet tab whose wallet cannot be forgotten, I sign out locally and the failure reaches my caller', async () => {
    // Given a local page whose switch back fails
    const fakes = harness({ walletMode: 'local', leaveOutcome: 'failed' });

    // When the page signs out locally
    const signOut = fakes.signOut.signOutLocally();

    // Then the sign-out rejects
    await expect(signOut).rejects.toThrow('The local wallet could not be forgotten');
  });
});
