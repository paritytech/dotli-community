// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { recordLog } from '@dotli/shared/testing';
import type { Presence } from '../session/presence.js';
import { createFakeSessionPresence } from '../session/presence.fake.js';
import { reconcileWithPresence, type RestoreStore } from '../session/restore-rule.js';
import { signOutInWindow } from './window-signout.js';

const BLOB = '0xsession';
const NEW_BLOB = '0xnewsession';
const UI_STATE = '{"connected":true}';
const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const NEW_ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => 100 + i);

interface HarnessOptions {
  flag?: Presence;
  notified?: boolean;
  session?: string | null;
  wallet?: boolean;
  failures?: { session?: boolean; wallet?: Error; end?: Error; drop?: Error };
  /** Another tab's writes, run while the window's core ends the session. */
  duringEnd?: () => void;
  /** Another tab's writes, run while the restore rule drops the session it read. */
  duringDrop?: () => void;
}

/** A sign-out window over fakes: the flag, the main store, the restore rule over both and the window's own core. */
function harness(options: HarnessOptions = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
  const presence = createFakeSessionPresence(options.flag ?? 'absent');
  const main: { session: string | null; uiState: string | null; wallet: Uint8Array | null } = {
    session: options.session ?? null,
    uiState: options.session === undefined || options.session === null ? null : UI_STATE,
    wallet: options.wallet === true ? ENTROPY : null,
  };
  const failures = options.failures ?? {};
  const calls: string[] = [];
  const ended: string[] = [];
  const store: RestoreStore = {
    readSession: () => {
      calls.push('readSession');
      return Promise.resolve(
        failures.session === true
          ? { status: 'failed', error: new Error('frame down') }
          : { status: 'ok', blob: main.session },
      );
    },
    dropSessionIf: blob => {
      calls.push('dropSession');
      options.duringDrop?.();
      if (failures.drop !== undefined) {
        return Promise.reject(failures.drop);
      }
      const holds = main.session === blob;
      if (holds) {
        main.session = null;
        main.uiState = null;
      }
      return Promise.resolve(holds);
    },
    readWallet: () => {
      calls.push('readWallet');
      if (failures.wallet !== undefined) {
        return Promise.reject(failures.wallet);
      }
      return Promise.resolve(
        main.wallet === null
          ? { status: 'none' }
          : { status: 'ok', entropy: main.wallet, identity: null, version: main.wallet },
      );
    },
  };
  // Memoised, so every caller gets the first run's answer.
  let answer: ReturnType<typeof reconcileWithPresence> | undefined;
  const restore = (): ReturnType<typeof reconcileWithPresence> =>
    (answer ??= reconcileWithPresence({ presence, store }, 'window'));
  const run = (): Promise<unknown> =>
    signOutInWindow({
      notified: options.notified ?? false,
      restore,
      endSession: blob => {
        calls.push('endSession');
        options.duringEnd?.();
        if (failures.end !== undefined) {
          return Promise.reject(failures.end);
        }
        ended.push(blob);
        return Promise.resolve();
      },
      read: () => {
        calls.push('read');
      },
      close: () => {
        calls.push('close');
      },
      showSignedOut: () => {
        calls.push('signed out');
      },
    });
  return { run, restore, main, calls, ended, presence, metrics, errors };
}

describe('signOutInWindow', () => {
  it('As a user in the sign-out window, I sign out and the phone is told when the page could not tell it', async () => {
    // Given a page in local mode signed out, so the flag is gone and the paired session is still stored
    const { run, main, ended, presence, metrics } = harness({ session: BLOB });

    // When the sign-out flow runs
    await run();

    // Then the session was ended on the window's core, and the rule cleared the store
    expect(ended).toEqual([BLOB]);
    expect(main).toEqual({ session: null, uiState: null, wallet: null });
    expect(presence.calls).not.toContain('clear');
    expect(metrics.counted('session_window.signout_result')).toEqual([{ outcome: 'told_phone', reason: 'unnotified' }]);
    expect(metrics.counted('session.presence')).toEqual([{ outcome: 'dropped', reason: 'window' }]);
  });

  it('As a user in the sign-out window, I sign out and the page is told once, after the rule read the store and before the session ends', async () => {
    // Given a stored session the page did not tell the phone about
    const { run, calls } = harness({ session: BLOB });

    // When the sign-out flow runs
    await run();

    // Then the page may clear its copy, which may be the main store, since the window holds what it ends
    expect(calls.filter(call => call === 'read')).toHaveLength(1);
    expect(calls.indexOf('readSession')).toBeLessThan(calls.indexOf('read'));
    expect(calls.indexOf('read')).toBeLessThan(calls.indexOf('endSession'));
  });

  it('As a user in a sign-out window whose boot ran the rule before its flow, I sign out and the session it found dead still ends', async () => {
    // Given the restore already ran, so the store no longer holds the session
    const { run, restore, main, ended, metrics } = harness({ session: BLOB });
    await restore();
    expect(main.session).toBeNull();

    // When the sign-out flow runs
    await run();

    // Then the dead session is ended and the phone counted told
    expect(ended).toEqual([BLOB]);
    expect(metrics.counted('session_window.signout_result')).toEqual([{ outcome: 'told_phone', reason: 'unnotified' }]);
  });

  it('As a user in the sign-out window whose page already told the phone, I sign out and the store is only cleared', async () => {
    // Given a stored session the page already told the phone about
    const { run, main, ended, metrics } = harness({ notified: true, session: BLOB });

    // When the sign-out flow runs
    await run();

    // Then nothing is ended and the store is cleared
    expect(ended).toEqual([]);
    expect(main).toEqual({ session: null, uiState: null, wallet: null });
    expect(metrics.counted('session_window.signout_result')).toEqual([{ outcome: 'cleared', reason: 'notified' }]);
  });

  it('As a user in the sign-out window, I sign out and a stored local wallet is left to the page that signs out of it', async () => {
    // Given a store holding only a local wallet
    const { run, main, ended, metrics } = harness({ wallet: true });

    // When the sign-out flow runs
    await run();

    // Then the wallet stays and nothing was signed out
    expect(ended).toEqual([]);
    expect(main.wallet).toEqual(ENTROPY);
    expect(metrics.counted('session_window.signout_result')).toEqual([{ outcome: 'nothing', reason: 'unnotified' }]);
  });

  it('As a user in a sign-out window over a store that holds nothing, I sign out and am told there was nothing to sign out', async () => {
    // Given an empty store
    const { run, ended, metrics } = harness();

    // When the sign-out flow runs
    await run();

    // Then nothing is ended and nothing was signed out
    expect(ended).toEqual([]);
    expect(metrics.counted('session_window.signout_result')).toEqual([{ outcome: 'nothing', reason: 'unnotified' }]);
    expect(metrics.counted('session.presence')).toEqual([]);
  });

  it('As a user in a sign-out window opened by a link while the cookie is present, I open it and the store is left alone', async () => {
    // Given a stored session and wallet with the cookie present
    const { run, main, calls, presence, metrics } = harness({ flag: 'present', session: BLOB, wallet: true });

    // When the sign-out flow runs
    await run();

    // Then nothing was ended or cleared, the page was told, and the flag is as it was
    expect(calls.filter(call => ['endSession', 'dropSession'].includes(call))).toEqual([]);
    expect(calls.slice(-2)).toEqual(['read', 'close']);
    expect(main).toEqual({ session: BLOB, uiState: UI_STATE, wallet: ENTROPY });
    expect(presence.calls).toEqual(['read']);
    expect(metrics.counted('session_window.signout_result')).toEqual([{ outcome: 'kept', reason: 'unnotified' }]);
  });

  it('As a user in a sign-out window whose flag cannot be read, I sign out and the store is kept with no session ended', async () => {
    // Given a stored session whose flag cannot be read
    const { run, main, calls, metrics } = harness({ flag: 'unknown', session: BLOB });

    // When the sign-out flow runs
    await run();

    // Then the session is kept and counted kept
    expect(calls).not.toContain('endSession');
    expect(main.session).toBe(BLOB);
    expect(metrics.counted('session_window.signout_result')).toEqual([{ outcome: 'kept', reason: 'unnotified' }]);
  });

  it('As a user in the sign-out window while another tab signs in, I sign out and the old session ends while the new one stays', async () => {
    // Given another tab sets the flag and stores its session while the window's core tells the phone
    const NEW_UI_STATE = '{"connected":true,"liteUsername":"new"}';
    const signIn = (): void => {
      void presence.set();
      main.session = NEW_BLOB;
      main.uiState = NEW_UI_STATE;
    };
    const { run, main, ended, presence, metrics } = harness({ session: BLOB, duringEnd: signIn });

    // When the sign-out flow runs
    await run();

    // Then the old session was ended after the rule cleared it, and the new session, its account and the flag stay
    expect(ended).toEqual([BLOB]);
    expect(main).toEqual({ session: NEW_BLOB, uiState: NEW_UI_STATE, wallet: null });
    expect(presence.state).toBe('present');
    expect(presence.calls).not.toContain('clear');
    expect(metrics.counted('session_window.signout_result')).toEqual([{ outcome: 'told_phone', reason: 'unnotified' }]);
  });

  it('As a user in the sign-out window while another tab imports a wallet, I sign out and only what was read is dropped while the new wallet stays', async () => {
    // Given the page already told the phone, and a phrase import elsewhere lands while the rule clears
    const importElsewhere = (): void => {
      void presence.set();
      main.wallet = NEW_ENTROPY;
    };
    const { run, main, presence, metrics } = harness({
      notified: true,
      session: BLOB,
      wallet: true,
      duringDrop: importElsewhere,
    });

    // When the sign-out flow runs
    await run();

    // Then the session the window read is gone, while the wallet and the flag the import set stay
    expect(main).toEqual({ session: null, uiState: null, wallet: NEW_ENTROPY });
    expect(presence.state).toBe('present');
    expect(presence.calls).not.toContain('clear');
    expect(metrics.counted('session_window.signout_result')).toEqual([{ outcome: 'cleared', reason: 'notified' }]);
  });

  it('As a user in a sign-out window that told the phone, I sign out and it stays open saying I am signed out, since its message may still be on its way', async () => {
    // Given a stored session the page did not tell the phone about
    const { run, calls } = harness({ session: BLOB });

    // When the sign-out flow runs
    await run();

    // Then the user closes the window, once the phone was told
    expect(calls.at(-1)).toBe('signed out');
    expect(calls).not.toContain('close');
    expect(calls.indexOf('endSession')).toBeLessThan(calls.indexOf('signed out'));
  });

  it('As a user in a sign-out window whose page told the phone itself, I sign out and the window closes when done', async () => {
    // Given a stored session the page already told the phone about
    const { run, calls } = harness({ session: BLOB, notified: true });

    // When the sign-out flow runs
    await run();

    // Then the window closes once, after the store is cleared
    expect(calls.filter(call => call === 'close')).toHaveLength(1);
    expect(calls.at(-1)).toBe('close');
    expect(calls).not.toContain('signed out');
    expect(calls.indexOf('dropSession')).toBeLessThan(calls.indexOf('close'));
  });

  it('As a user in a sign-out window whose core could not tell the phone, I sign out and it reports that, clears anyway and closes', async () => {
    // Given a stored session whose end on the core fails
    const { run, main, calls, metrics, errors } = harness({ session: BLOB, failures: { end: new Error('core down') } });

    // When the sign-out flow runs
    await run();

    // Then the store is cleared, the window closes and the failure is counted and logged
    expect(main.session).toBeNull();
    expect(calls.at(-1)).toBe('close');
    expect(metrics.counted('session_window.signout_result')).toEqual([{ outcome: 'error', reason: 'unnotified' }]);
    expect(errors).toHaveLength(1);
  });

  it("As a user in a sign-out window whose wallet read failed, I sign out and the phone is told and counted told, since the wallet is the page's to forget", async () => {
    // Given a stored session whose wallet read fails
    const { run, main, ended, calls, metrics, errors } = harness({
      session: BLOB,
      failures: { wallet: new Error('frame') },
    });

    // When the sign-out flow runs
    await run();

    // Then it stays open, as the phone's message may still be on its way
    expect(ended).toEqual([BLOB]);
    expect(calls.at(-1)).toBe('signed out');
    expect(main.session).toBeNull();
    expect(metrics.counted('session_window.signout_result')).toEqual([{ outcome: 'told_phone', reason: 'unnotified' }]);
    expect(errors).toHaveLength(0);
  });

  it('As a user in a sign-out window that could not read the session, I sign out and it says it failed and closes', async () => {
    // Given a stored session that cannot be read
    const { run, main, calls, metrics } = harness({ session: BLOB, failures: { session: true } });

    // When the sign-out flow runs
    await run();

    // Then the session it could not read stays for the restore rule on the next load
    expect(calls).not.toContain('endSession');
    expect(calls).not.toContain('dropSession');
    expect(main).toEqual({ session: BLOB, uiState: UI_STATE, wallet: null });
    expect(calls.at(-1)).toBe('close');
    expect(metrics.counted('session_window.signout_result')).toEqual([{ outcome: 'error', reason: 'unnotified' }]);
  });

  it('As a user in a sign-out window that could not drop the session, I sign out and it says it failed and closes', async () => {
    // Given a stored session the page told the phone about, whose drop fails
    const { run, main, calls, metrics } = harness({
      notified: true,
      session: BLOB,
      failures: { drop: new Error('quota') },
    });

    // When the sign-out flow runs
    await run();

    // Then the session stays, the window closes and the failure is counted twice
    expect(main.session).toBe(BLOB);
    expect(calls.at(-1)).toBe('close');
    expect(metrics.counted('session_window.signout_result')).toEqual([{ outcome: 'error', reason: 'notified' }]);
    expect(metrics.counted('session.presence')).toEqual([{ outcome: 'error', reason: 'window' }]);
  });
});
