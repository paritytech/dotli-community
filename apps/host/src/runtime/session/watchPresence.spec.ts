// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createAsyncTaskPool } from '@dotli/shared';
import { createManualTimers } from '@dotli/shared/testing';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createChanges } from '../../testing/changes.js';
import type { Presence } from './types.js';
import { watchPresence } from './watchPresence.js';
import type { WalletRead } from './siteWallet.js';

/** A watch over a fake restore rule and visibility, whose sign-outs the test settles. */
function createWatchHarness(
  flag: Presence,
  options: { signedIn?: boolean; wallet?: WalletRead; localWallet?: boolean } = {},
) {
  const changes = createChanges();
  const metrics = bindRecordingSentry({ onFinished: onTestFinished, onRecord: changes.notify });
  const captures = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));
  let listener: (() => void) | null = null;
  let signedIn = options.signedIn ?? true;
  let signedInChecks = 0;
  const signOuts: PromiseWithResolvers<undefined>[] = [];
  const current = flag;
  let followed = 0;
  const reported: Presence[] = [];
  const reconcile = vi.fn(() => {
    changes.notify();
    return Promise.resolve({ presence: current, wallet: options.wallet ?? { status: 'none' } });
  });
  // The page's sign-out queue, which the watch shares.
  const pageSignOuts = createAsyncTaskPool({ poolSize: 1 });
  const timers = createManualTimers();
  const stop = watchPresence({
    signOuts: pageSignOuts,
    timers: { setTimeout: scheduleRetry, clearTimeout: cancelRetry },
    subscribeRecheck: listenForRecheck,
    isSignedIn: checkSignedIn,
    reconcile,
    // A page on the local wallet runs on the record of version 1.
    readPageWalletVersion: () => Promise.resolve(options.localWallet === true ? Uint8Array.of(1) : null),
    followWallet,
    signOutLocally,
    readFlag: () => Promise.resolve(current),
    reportFlag,
  });
  return {
    metrics,
    captures,
    changes,
    reconcile,
    signOuts,
    pageSignOuts,
    timers,
    stop,
    becomeVisible,
    listening: () => listener !== null,
    /** The flags the watch read on a page that held no sign-in. */
    reported,
    signedInChecks: () => signedInChecks,
    /** How many times the page reloaded to follow the wallet another tab saved. */
    followed: () => followed,
    /** The sign-out ending, which leaves the page signed out. */
    finishSignOut,
    /** The page's own sign-out leaving the page signed out. */
    signOutHere,
  };

  // A retry scheduled is a change a test may wait on.
  function scheduleRetry(callback: () => void, ms: number): number {
    const handle = timers.setTimeout(callback, ms);
    changes.notify();
    return handle;
  }

  function cancelRetry(handle: unknown): void {
    timers.clearTimeout(handle);
  }

  function listenForRecheck(next: () => void): () => void {
    listener = next;
    return stopListening;

    function stopListening(): void {
      listener = null;
    }
  }

  function checkSignedIn(): boolean {
    signedInChecks += 1;
    changes.notify();
    return signedIn;
  }

  function followWallet(): void {
    followed += 1;
    changes.notify();
  }

  function signOutLocally(): Promise<undefined> {
    const signOut = Promise.withResolvers<undefined>();
    signOuts.push(signOut);
    changes.notify();
    return signOut.promise;
  }

  function reportFlag(presence: Presence): void {
    reported.push(presence);
    changes.notify();
  }

  function becomeVisible(): void {
    listener?.();
  }

  function finishSignOut(index: number): void {
    signedIn = false;
    signOuts[index]?.resolve(undefined);
  }

  function signOutHere(): void {
    signedIn = false;
  }
}

describe('presence watch', () => {
  it('As a user with a tab left open, I come back to it after the cookie went and am signed out once', async () => {
    // Given a signed-in tab whose flag is gone
    const tab = createWatchHarness('absent');

    // When the tab becomes visible twice before the first sign-out ends
    tab.becomeVisible();
    tab.becomeVisible();
    await tab.changes.until(() => tab.signOuts.length === 1);
    tab.finishSignOut(0);
    await tab.pageSignOuts.settle();

    // Then the rule ran once, for both events, and the sign-out is counted
    expect(tab.signOuts).toHaveLength(1);
    expect(tab.reconcile).toHaveBeenCalledTimes(1);
    expect(tab.metrics.counted('session.presence_watch')).toEqual([{ outcome: 'signed_out', reason: 'visible' }]);
  });

  it('As a user whose tab is signing out, I come back to the tab and the restore rule runs only once my sign-out ended', async () => {
    // Given the page's own sign-out under way, as one waiting for the sign-out window to read the paired copy
    const tab = createWatchHarness('absent');
    const ownSignOut = Promise.withResolvers<undefined>();
    let ruleRanDuringSignOut = -1;
    const signingOut = tab.pageSignOuts.call(async () => {
      await ownSignOut.promise;
      ruleRanDuringSignOut = tab.reconcile.mock.calls.length;
    });

    // When the tab becomes visible while its sign-out runs, and the sign-out ends
    tab.becomeVisible();
    ownSignOut.resolve(undefined);
    await signingOut;
    await tab.changes.until(() => tab.reconcile.mock.calls.length === 1);

    // Then the rule ran only once the sign-out had ended
    expect(ruleRanDuringSignOut).toBe(0);
  });

  it('As a user whose sign-out waits for the sign-out window, I come back to the tab many times and no restore rule runs once it signed me out', async () => {
    // Given the page's own sign-out waiting on the sign-out window, which leaves the page signed out
    const tab = createWatchHarness('present');
    const read = Promise.withResolvers<undefined>();
    const signingOut = tab.pageSignOuts.call(async () => {
      await read.promise;
      tab.signOutHere();
    });

    // When the user comes back to the tab many times meanwhile, and the window reads at last
    for (let visit = 0; visit < 5; visit += 1) {
      tab.becomeVisible();
    }
    read.resolve(undefined);
    await signingOut;
    await tab.pageSignOuts.settle();

    // Then each queued check found the page signed out, and only read the flag
    expect(tab.reconcile).not.toHaveBeenCalled();
    expect(tab.reported).toHaveLength(5);
    expect(tab.signedInChecks()).toBe(5);
  });

  it('As a signed-in user, I come back to the tab while the cookie is present and nothing signs out or counts', async () => {
    // Given a signed-in tab whose flag is present
    const tab = createWatchHarness('present');

    // When the tab becomes visible twice
    tab.becomeVisible();
    tab.becomeVisible();
    await tab.changes.until(() => tab.signedInChecks() === 2);

    // Then the rule ran each time, nothing signed out and nothing was counted
    expect(tab.reconcile).toHaveBeenCalledTimes(2);
    expect(tab.signOuts).toHaveLength(0);
    expect(tab.metrics.counted('session.presence_watch')).toEqual([]);
  });

  it('As a user whose cookie cannot be read, I come back to the tab and keep my session', async () => {
    // Given a signed-in tab whose flag cannot be read
    const tab = createWatchHarness('unknown');

    // When the tab becomes visible twice
    tab.becomeVisible();
    tab.becomeVisible();
    await tab.changes.until(() => tab.signedInChecks() === 2);

    // Then nothing signed out
    expect(tab.signOuts).toHaveLength(0);
  });

  it('As a signed-out user, I come back to the tab and no restore rule runs while the flag read is reported', async () => {
    // Given a signed-out tab whose flag is gone
    const tab = createWatchHarness('absent', { signedIn: false });

    // When the tab becomes visible
    tab.becomeVisible();
    await tab.changes.until(() => tab.reported.length === 1);

    // Then no rule ran and the flag read was reported
    expect(tab.reconcile).not.toHaveBeenCalled();
    expect(tab.signOuts).toHaveLength(0);
    expect(tab.reported).toEqual(['absent']);
  });

  it('As a signed-in user, I come back to the tab and the recheck reports no flag, since my own sign-in speaks for me', async () => {
    // Given a signed-in tab whose flag is present
    const tab = createWatchHarness('present');

    // When the tab becomes visible
    tab.becomeVisible();
    await tab.pageSignOuts.settle();

    // Then no flag was reported
    expect(tab.reported).toEqual([]);
  });

  it('As a user whose wallet could not be read, I come back to a tab whose cookie is gone and still sign out with the miss recorded', async () => {
    // Given a tab whose flag is gone and whose wallet read fails
    const failure = new Error('frame unavailable');
    const tab = createWatchHarness('absent', { wallet: { status: 'failed', error: failure } });

    // When the tab becomes visible
    tab.becomeVisible();
    await tab.changes.until(() => tab.signOuts.length === 1);

    // Then the wallet miss is recorded as expected
    expect(tab.captures.expected).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ step: 'presence_wallet_read' }),
    );
  });

  it.each<{ label: string; wallet: WalletRead }>([
    {
      label: 'whose flag is gone while the wallet is stored, I come back to it and stay signed in',
      wallet: { status: 'ok', entropy: Uint8Array.of(1), identity: null, version: Uint8Array.of(1) },
    },
    {
      label: 'whose wallet could not be read, I come back to it and stay signed in until a recheck can tell',
      wallet: { status: 'failed', error: new Error('frame') },
    },
    {
      label: 'whose wallet read as unreadable, I come back to it and stay signed in until a recheck reads it gone',
      wallet: { status: 'unreadable' },
    },
  ])('As a developer on a local wallet tab $label', async ({ wallet }) => {
    // Given a local wallet tab whose flag is gone
    const tab = createWatchHarness('absent', { localWallet: true, wallet });

    // When the tab becomes visible
    tab.becomeVisible();
    await tab.pageSignOuts.settle();

    // Then the rule ran once and nothing signed out or was counted
    expect(tab.reconcile).toHaveBeenCalledTimes(1);
    expect(tab.signOuts).toHaveLength(0);
    expect(tab.metrics.counted('session.presence_watch')).toEqual([]);
  });

  it('As a developer on a local wallet tab whose wallet was forgotten while another sign-in keeps the flag up, I come back to it and am signed out', async () => {
    // Given a local wallet tab whose wallet is gone while the flag is present
    const tab = createWatchHarness('present', { localWallet: true, wallet: { status: 'none' } });

    // When the tab becomes visible and its sign-out ends
    tab.becomeVisible();
    await tab.changes.until(() => tab.signOuts.length === 1);
    tab.finishSignOut(0);
    await tab.pageSignOuts.settle();

    // Then one sign-out is counted
    expect(tab.metrics.counted('session.presence_watch')).toEqual([{ outcome: 'signed_out', reason: 'visible' }]);
  });

  it('As a developer on a local wallet tab whose wallet another tab replaced, I reload onto the new one and sign nothing out', async () => {
    // Given a local wallet tab whose stored wallet another tab replaced
    const replaced: WalletRead = { status: 'ok', entropy: Uint8Array.of(2), identity: null, version: Uint8Array.of(2) };
    const tab = createWatchHarness('present', { localWallet: true, wallet: replaced });

    // When the tab becomes visible
    tab.becomeVisible();
    await tab.changes.until(() => tab.followed() === 1);
    await tab.pageSignOuts.settle();

    // Then nothing signed out and the switch is counted
    expect(tab.signOuts).toHaveLength(0);
    expect(tab.metrics.counted('session.presence_watch')).toEqual([{ outcome: 'switched', reason: 'visible' }]);
  });

  it('As a user signed out elsewhere, I come back to the tab and a failed local sign-out is retried until it lands', async () => {
    // Given a sign-out of this page that fails twice
    const tab = createWatchHarness('absent');
    const failure = new Error('frame unavailable');
    tab.becomeVisible();
    await tab.changes.until(() => tab.signOuts.length === 1);

    // When each try fails until the third, after the waits between them
    tab.signOuts[0]?.reject(failure);
    await tab.timers.advance(1000);
    await tab.changes.until(() => tab.signOuts.length === 2);
    tab.signOuts[1]?.reject(failure);
    await tab.timers.advance(4000);
    await tab.changes.until(() => tab.signOuts.length === 3);
    tab.finishSignOut(2);
    await tab.changes.until(() => tab.metrics.counted('session.presence_watch').length === 1);

    // Then the page is signed out once and no failure is reported
    expect(tab.metrics.counted('session.presence_watch')).toEqual([{ outcome: 'signed_out', reason: 'visible' }]);
    expect(tab.captures.exception).not.toHaveBeenCalled();
  });

  it('As a user whose local sign-out keeps failing, I come back to the tab and the failure is reported once after the last retry', async () => {
    // Given a sign-out of this page that fails every time
    const tab = createWatchHarness('absent');
    const failure = new Error('frame unavailable');
    tab.becomeVisible();
    await tab.changes.until(() => tab.signOuts.length === 1);

    // When the first try and every retry but the last fail
    for (const [index, wait] of [1000, 4000, 16000].entries()) {
      tab.signOuts[index]?.reject(failure);
      await tab.timers.advance(wait);
      await tab.changes.until(() => tab.signOuts.length === index + 2);
    }

    // Then nothing is reported while a retry is left
    expect(tab.captures.exception).not.toHaveBeenCalled();

    // When the last retry fails too
    tab.signOuts[3]?.reject(failure);
    await tab.changes.until(() => tab.metrics.counted('session.presence_watch').length === 1);

    // Then the failure the sign-out gave is reported once
    expect(tab.captures.exception).toHaveBeenCalledTimes(1);
    expect(tab.captures.exception).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        step: 'presence_signout',
        tags: { reason: 'visible' },
      }),
    );
    expect(tab.metrics.counted('session.presence_watch')).toEqual([{ outcome: 'error', reason: 'visible' }]);
  });

  it('As a user whose sign-out retry waits, I come back to the tab again and the newer check replaces the waiting one', async () => {
    // Given a failed sign-out whose retry waits
    const tab = createWatchHarness('absent');
    tab.becomeVisible();
    await tab.changes.until(() => tab.signOuts.length === 1);
    tab.signOuts[0]?.reject(new Error('frame unavailable'));
    await tab.changes.until(() => tab.timers.countPending() === 1);

    // When the page rechecks meanwhile
    tab.becomeVisible();
    await tab.changes.until(() => tab.signOuts.length === 2);

    // Then the waiting retry is gone
    expect(tab.timers.countPending()).toBe(0);

    // When the newer check's sign-out lands and the longest retry wait passes
    tab.finishSignOut(1);
    await tab.timers.advance(16000);

    // Then no other sign-out ran, and the sign-in ended with nothing reported
    expect(tab.signOuts).toHaveLength(2);
    expect(tab.captures.exception).not.toHaveBeenCalled();
    expect(tab.metrics.counted('session.presence_watch')).toEqual([{ outcome: 'signed_out', reason: 'visible' }]);
  });

  it('As a user leaving the page, I stop the watch and a waiting retry never runs', async () => {
    // Given a failed sign-out whose retry waits
    const tab = createWatchHarness('absent');
    tab.becomeVisible();
    await tab.changes.until(() => tab.signOuts.length === 1);
    tab.signOuts[0]?.reject(new Error('frame unavailable'));
    await tab.changes.until(() => tab.timers.countPending() === 1);

    // When the watch stops
    tab.stop();

    // Then no retry waits
    expect(tab.timers.countPending()).toBe(0);

    // When the longest retry wait passes
    await tab.timers.advance(16000);

    // Then no retry ran and nothing is reported
    expect(tab.signOuts).toHaveLength(1);
    expect(tab.captures.exception).not.toHaveBeenCalled();
  });

  it('As a user of a tab whose watch stopped, I switch tabs and the page no longer listens for visibility', () => {
    // Given a watching tab
    const tab = createWatchHarness('absent');

    // When the watch stops
    tab.stop();

    // Then the visibility listener is gone
    expect(tab.listening()).toBe(false);
  });
});
