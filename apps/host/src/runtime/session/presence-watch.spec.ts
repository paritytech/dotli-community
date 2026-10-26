// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createAsyncTaskPool } from '@dotli/shared';
import { manualTimers } from '@dotli/shared/testing';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createChanges } from '../../testing/changes.js';
import type { Presence } from './presence.js';
import { watchPresence } from './presence-watch.js';
import type { WalletRead } from './site-wallet.js';

/** A watch over a fake restore rule and visibility, whose sign-outs the test settles. */
function harness(flag: Presence, options: { signedIn?: boolean; wallet?: WalletRead; localWallet?: boolean } = {}) {
  const changes = createChanges();
  const metrics = bindRecordingSentry({ onFinished: onTestFinished, onRecord: changes.notify });
  const captures = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));
  let listener: (() => void) | null = null;
  let signedIn = options.signedIn ?? true;
  let signedInChecks = 0;
  const signOuts: PromiseWithResolvers<undefined>[] = [];
  let current = flag;
  let followed = 0;
  const reported: Presence[] = [];
  const reconcile = vi.fn(() => {
    changes.notify();
    return Promise.resolve({ presence: current, wallet: options.wallet ?? { status: 'none' } });
  });
  // The page's sign-out queue, which the watch shares.
  const pageSignOuts = createAsyncTaskPool({ poolSize: 1 });
  const timers = manualTimers();
  const stop = watchPresence({
    signOuts: pageSignOuts,
    timers: {
      // A retry scheduled is a change a test may wait on.
      setTimeout: (callback, ms) => {
        const handle = timers.setTimeout(callback, ms);
        changes.notify();
        return handle;
      },
      clearTimeout: handle => {
        timers.clearTimeout(handle);
      },
    },
    onRecheck: next => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    signedIn: () => {
      signedInChecks += 1;
      changes.notify();
      return signedIn;
    },
    reconcile,
    // A page on the local wallet runs on the record of version 1.
    pageWallet: () => Promise.resolve(options.localWallet === true ? Uint8Array.of(1) : null),
    followWallet: () => {
      followed += 1;
      changes.notify();
    },
    signOutLocally: () => {
      const signOut = Promise.withResolvers<undefined>();
      signOuts.push(signOut);
      changes.notify();
      return signOut.promise;
    },
    readFlag: () => Promise.resolve(current),
    reportFlag: presence => {
      reported.push(presence);
      changes.notify();
    },
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
    becomeVisible: () => {
      listener?.();
    },
    listening: () => listener !== null,
    /** The flags the watch read on a page that held no sign-in. */
    reported,
    /** The flag changing through a sign-in or a sign-out on another page. */
    setFlag: (next: Presence) => {
      current = next;
    },
    signedInChecks: () => signedInChecks,
    /** How many times the page reloaded to follow the wallet another tab saved. */
    followed: () => followed,
    /** The sign-out ending, which leaves the page signed out. */
    finishSignOut: (index: number) => {
      signedIn = false;
      signOuts[index]?.resolve(undefined);
    },
    /** The page's own sign-out leaving the page signed out. */
    signOutHere: () => {
      signedIn = false;
    },
  };
}

describe('presence watch', () => {
  it('As a tab left open, I sign out once when I become visible and the cookie is gone', async () => {
    // Given a signed-in tab whose flag is gone
    const tab = harness('absent');

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
    const tab = harness('absent');
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
    const tab = harness('present');
    const read = Promise.withResolvers<undefined>();
    const signingOut = tab.pageSignOuts.call(async () => {
      await read.promise;
      tab.signOutHere();
    });

    // When the user comes back to the tab many times meanwhile, and the window reads at last
    for (let i = 0; i < 5; i += 1) {
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

  it('As a signed-in user, I come back to the tab twice and each visit applies the restore rule while I stay signed in', async () => {
    // Given a signed-in tab whose flag is present
    const tab = harness('present');

    // When the tab becomes visible twice
    tab.becomeVisible();
    tab.becomeVisible();
    await tab.pageSignOuts.settle();

    // Then the rule ran for each visit
    expect(tab.reconcile).toHaveBeenCalledTimes(2);
  });

  it('As a tab, I do nothing on visible while the cookie is present', async () => {
    // Given a signed-in tab whose flag is present
    const tab = harness('present');

    // When the tab becomes visible twice
    tab.becomeVisible();
    tab.becomeVisible();
    await tab.changes.until(() => tab.signedInChecks() === 2);

    // Then the rule ran each time, nothing signed out and nothing was counted
    expect(tab.reconcile).toHaveBeenCalledTimes(2);
    expect(tab.signOuts).toHaveLength(0);
    expect(tab.metrics.counted('session.presence_watch')).toEqual([]);
  });

  it('As a tab whose cookie cannot be read, I keep my session on visible', async () => {
    // Given a signed-in tab whose flag cannot be read
    const tab = harness('unknown');

    // When the tab becomes visible twice
    tab.becomeVisible();
    tab.becomeVisible();
    await tab.changes.until(() => tab.signedInChecks() === 2);

    // Then nothing signed out
    expect(tab.signOuts).toHaveLength(0);
  });

  it('As a signed-out tab, I do not apply the restore rule on visible, and only report the flag I read', async () => {
    // Given a signed-out tab whose flag is gone
    const tab = harness('absent', { signedIn: false });

    // When the tab becomes visible
    tab.becomeVisible();
    await tab.changes.until(() => tab.reported.length === 1);

    // Then no rule ran and the flag read was reported
    expect(tab.reconcile).not.toHaveBeenCalled();
    expect(tab.signOuts).toHaveLength(0);
    expect(tab.reported).toEqual(['absent']);
  });

  it('As a signed-out user, I come back to the tab after a sign-in elsewhere and again after it ended, and each recheck reports the flag', async () => {
    // Given a signed-out tab whose flag is absent
    const tab = harness('absent', { signedIn: false });

    // When a sign-in is made on another product, then signed out
    tab.setFlag('present');
    tab.becomeVisible();
    await tab.changes.until(() => tab.reported.length === 1);
    tab.setFlag('absent');
    tab.becomeVisible();
    await tab.changes.until(() => tab.reported.length === 2);

    // Then each recheck reported the flag it read
    expect(tab.reported).toEqual(['present', 'absent']);
  });

  it('As a signed-in user, I come back to the tab and the recheck reports no flag, since my own sign-in speaks for me', async () => {
    // Given a signed-in tab whose flag is present
    const tab = harness('present');

    // When the tab becomes visible
    tab.becomeVisible();
    await tab.pageSignOuts.settle();

    // Then no flag was reported
    expect(tab.reported).toEqual([]);
  });

  it('As a tab whose wallet could not be read, I still sign out and the miss is recorded', async () => {
    // Given a tab whose flag is gone and whose wallet read fails
    const failure = new Error('frame unavailable');
    const tab = harness('absent', { wallet: { status: 'failed', error: failure } });

    // When the tab becomes visible
    tab.becomeVisible();
    await tab.changes.until(() => tab.signOuts.length === 1);

    // Then the wallet miss is recorded as expected
    expect(tab.captures.expected).toHaveBeenCalledWith(failure, { flow: 'wallet', step: 'presence_wallet_read' });
  });

  it('As a developer on a local wallet tab whose flag is gone while the wallet is stored, I stay signed in on it', async () => {
    // Given a local wallet tab whose flag is gone while the wallet is stored
    const wallet: WalletRead = { status: 'ok', entropy: Uint8Array.of(1), identity: null, version: Uint8Array.of(1) };
    const tab = harness('absent', { localWallet: true, wallet });

    // When the tab becomes visible
    tab.becomeVisible();
    await tab.pageSignOuts.settle();

    // Then the rule ran once and nothing signed out or was counted
    expect(tab.reconcile).toHaveBeenCalledTimes(1);
    expect(tab.signOuts).toHaveLength(0);
    expect(tab.metrics.counted('session.presence_watch')).toEqual([]);
  });

  it('As a developer on a local wallet tab whose wallet could not be read, I stay signed in until a recheck can tell', async () => {
    // Given a local wallet tab whose flag is gone and whose wallet read fails
    const tab = harness('absent', { localWallet: true, wallet: { status: 'failed', error: new Error('frame') } });

    // When the tab becomes visible
    tab.becomeVisible();
    await tab.pageSignOuts.settle();

    // Then nothing signed out
    expect(tab.signOuts).toHaveLength(0);
  });

  it('As a developer on a local wallet tab whose wallet a sign-out elsewhere forgot, I sign out once', async () => {
    // Given a local wallet tab whose flag and wallet are gone
    const tab = harness('absent', { localWallet: true, wallet: { status: 'none' } });

    // When the tab becomes visible and its sign-out ends
    tab.becomeVisible();
    await tab.changes.until(() => tab.signOuts.length === 1);
    tab.finishSignOut(0);
    await tab.pageSignOuts.settle();

    // Then one sign-out is counted
    expect(tab.metrics.counted('session.presence_watch')).toEqual([{ outcome: 'signed_out', reason: 'visible' }]);
  });

  it('As a developer on a local wallet tab whose wallet was forgotten while another sign-in keeps the flag up, I sign out', async () => {
    // Given a local wallet tab whose wallet is gone while the flag is present
    const tab = harness('present', { localWallet: true, wallet: { status: 'none' } });

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
    const tab = harness('present', { localWallet: true, wallet: replaced });

    // When the tab becomes visible
    tab.becomeVisible();
    await tab.changes.until(() => tab.followed() === 1);
    await tab.pageSignOuts.settle();

    // Then nothing signed out and the switch is counted
    expect(tab.signOuts).toHaveLength(0);
    expect(tab.metrics.counted('session.presence_watch')).toEqual([{ outcome: 'switched', reason: 'visible' }]);
  });

  it('As a developer on a local wallet tab whose wallet read as unreadable, I stay signed in until a recheck reads it gone', async () => {
    // Given a local wallet tab whose flag is gone and whose wallet reads unreadable
    const tab = harness('absent', { localWallet: true, wallet: { status: 'unreadable' } });

    // When the tab becomes visible
    tab.becomeVisible();
    await tab.pageSignOuts.settle();

    // Then the rule ran once and nothing signed out
    expect(tab.reconcile).toHaveBeenCalledTimes(1);
    expect(tab.signOuts).toHaveLength(0);
  });

  it('As a tab signed out elsewhere, I retry a failed local sign-out until it lands', async () => {
    // Given a sign-out of this page that fails twice
    const tab = harness('absent');
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

  it('As a tab whose local sign-out keeps failing, I report it once after the last retry', async () => {
    // Given a sign-out of this page that fails every time
    const tab = harness('absent');
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
    expect(tab.captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'wallet',
      step: 'presence_signout',
      tags: { reason: 'visible' },
    });
    expect(tab.metrics.counted('session.presence_watch')).toEqual([{ outcome: 'error', reason: 'visible' }]);
  });

  it('As a tab that rechecks while a retry waits, I let the newer check replace the waiting one', async () => {
    // Given a failed sign-out whose retry waits
    const tab = harness('absent');
    tab.becomeVisible();
    await tab.changes.until(() => tab.signOuts.length === 1);
    tab.signOuts[0]?.reject(new Error('frame unavailable'));
    await tab.changes.until(() => tab.timers.pending() === 1);

    // When the page rechecks meanwhile
    tab.becomeVisible();
    await tab.changes.until(() => tab.signOuts.length === 2);

    // Then the waiting retry is gone
    expect(tab.timers.pending()).toBe(0);

    // When the newer check's sign-out lands and the longest retry wait passes
    tab.finishSignOut(1);
    await tab.timers.advance(16000);

    // Then no other sign-out ran, and the sign-in ended with nothing reported
    expect(tab.signOuts).toHaveLength(2);
    expect(tab.captures.exception).not.toHaveBeenCalled();
    expect(tab.metrics.counted('session.presence_watch')).toEqual([{ outcome: 'signed_out', reason: 'visible' }]);
  });

  it('As a tab whose watch stopped, I run no retry that was waiting', async () => {
    // Given a failed sign-out whose retry waits
    const tab = harness('absent');
    tab.becomeVisible();
    await tab.changes.until(() => tab.signOuts.length === 1);
    tab.signOuts[0]?.reject(new Error('frame unavailable'));
    await tab.changes.until(() => tab.timers.pending() === 1);

    // When the watch stops
    tab.stop();

    // Then no retry waits
    expect(tab.timers.pending()).toBe(0);

    // When the longest retry wait passes
    await tab.timers.advance(16000);

    // Then no retry ran and nothing is reported
    expect(tab.signOuts).toHaveLength(1);
    expect(tab.captures.exception).not.toHaveBeenCalled();
  });

  it('As a user of a tab whose watch stopped, I switch tabs and the page no longer listens for visibility', () => {
    // Given a watching tab
    const tab = harness('absent');

    // When the watch stops
    tab.stop();

    // Then the visibility listener is gone
    expect(tab.listening()).toBe(false);
  });
});
