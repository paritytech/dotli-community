// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { recordLog } from '@dotli/shared/testing';
import type { Presence } from '../session/types.js';
import { createFakeSessionPresence } from '../session/createPagePresence.fake.js';
import { reconcileWithPresence, type RestoreStore } from '../session/restoreRule.js';
import { signOutInWindow } from './signOutInWindow.js';

type Params = {
  flag?: Presence;
  notified?: boolean;
  session?: string | null;
  wallet?: boolean;
  failures?: { session?: boolean; wallet?: Error; end?: Error; drop?: Error; grants?: Error };
  /** Another tab's writes, run while the window's core ends the session. */
  duringEnd?: () => void;
  /** Whether the round's first vetting is dot.li's own page, which it is by default. */
  firstParty?: Promise<boolean>;
};

const BLOB = '0xsession';
const NEW_BLOB = '0xnewsession';
const UI_STATE = '{"connected":true}';
const NEW_UI_STATE = '{"connected":true,"liteUsername":"new"}';
const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

/** A sign-out window over fakes: the flag, the main store, the restore rule over both and the window's own core. */
function openSignOutWindow(options: Params = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
  const captures = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));
  const presence = createFakeSessionPresence({ state: options.flag ?? 'absent' });
  const main: { session: string | null; uiState: string | null; wallet: Uint8Array | null } = {
    session: options.session ?? null,
    uiState: options.session === undefined || options.session === null ? null : UI_STATE,
    wallet: options.wallet === true ? ENTROPY : null,
  };
  const failures = options.failures ?? {};
  const calls: string[] = [];
  const ended: string[] = [];
  const store: RestoreStore = {
    readSession() {
      calls.push('readSession');
      return Promise.resolve(
        failures.session === true
          ? { status: 'failed', error: new Error('frame down') }
          : { status: 'ok', blob: main.session },
      );
    },
    dropSessionIf(blob) {
      calls.push('dropSession');
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
    readWallet() {
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

  /** The restore rule on the main store, run once for the window. */
  function restore(): ReturnType<typeof reconcileWithPresence> {
    answer ??= reconcileWithPresence({ presence, store }, 'window');
    return answer;
  }

  /** The window's sign-out over the fakes, answering how it ended. */
  function run(): Promise<unknown> {
    return signOutInWindow({
      notified: options.notified ?? false,
      restore,
      endSession(blob) {
        calls.push('endSession');
        options.duringEnd?.();
        if (failures.end !== undefined) {
          return Promise.reject(failures.end);
        }
        ended.push(blob);
        return Promise.resolve();
      },
      read() {
        calls.push('read');
      },
      firstParty: options.firstParty ?? Promise.resolve(true),
      forgetGrants() {
        calls.push('forget grants');
        return failures.grants === undefined ? Promise.resolve() : Promise.reject(failures.grants);
      },
      close() {
        calls.push('close');
      },
      showSignedOut() {
        calls.push('signed out');
      },
    });
  }

  return { run, main, calls, ended, presence, metrics, errors, captures };
}

describe('signing out in the sign-out window', () => {
  it('As a user in the sign-out window, I sign out and the phone is told when the page could not tell it', async () => {
    // Given a page in local mode signed out, so the flag is gone and the paired session is still stored
    const { run, main, ended, presence, metrics } = openSignOutWindow({ session: BLOB });

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
    const { run, calls } = openSignOutWindow({ session: BLOB });

    // When the sign-out flow runs
    await run();

    // Then the page may clear its copy, which may be the main store, since the window holds what it ends
    expect(calls.filter(call => call === 'read')).toHaveLength(1);
    expect(calls.indexOf('readSession')).toBeLessThan(calls.indexOf('read'));
    expect(calls.indexOf('read')).toBeLessThan(calls.indexOf('endSession'));
  });

  it('As a user in the sign-out window whose page already told the phone, I sign out and the store is only cleared', async () => {
    // Given a stored session the page already told the phone about
    const { run, main, ended, metrics } = openSignOutWindow({ notified: true, session: BLOB });

    // When the sign-out flow runs
    await run();

    // Then nothing is ended and the store is cleared
    expect(ended).toEqual([]);
    expect(main).toEqual({ session: null, uiState: null, wallet: null });
    expect(metrics.counted('session_window.signout_result')).toEqual([{ outcome: 'cleared', reason: 'notified' }]);
  });

  it('As a user in a sign-out window over a store that holds nothing, I sign out and am told there was nothing to sign out', async () => {
    // Given an empty store
    const { run, ended, metrics } = openSignOutWindow();

    // When the sign-out flow runs
    await run();

    // Then nothing is ended and nothing was signed out
    expect(ended).toEqual([]);
    expect(metrics.counted('session_window.signout_result')).toEqual([{ outcome: 'nothing', reason: 'unnotified' }]);
    expect(metrics.counted('session.presence')).toEqual([]);
  });

  it('As a user in a sign-out window opened by a link while the cookie is present, I open it and the store is left alone', async () => {
    // Given a stored session and wallet with the cookie present
    const { run, main, calls, presence, metrics } = openSignOutWindow({ flag: 'present', session: BLOB, wallet: true });

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
    const { run, main, calls, metrics } = openSignOutWindow({ flag: 'unknown', session: BLOB });

    // When the sign-out flow runs
    await run();

    // Then the session is kept and counted kept
    expect(calls).not.toContain('endSession');
    expect(main.session).toBe(BLOB);
    expect(metrics.counted('session_window.signout_result')).toEqual([{ outcome: 'kept', reason: 'unnotified' }]);
  });

  it('As a user in the sign-out window while another tab signs in, I sign out and the old session ends while the new one stays', async () => {
    // Given another tab sets the flag and stores its session while the window's core tells the phone
    const { run, main, ended, presence, metrics } = openSignOutWindow({ session: BLOB, duringEnd: signInElsewhere });

    function signInElsewhere(): void {
      void presence.set();
      main.session = NEW_BLOB;
      main.uiState = NEW_UI_STATE;
    }

    // When the sign-out flow runs
    await run();

    // Then the old session was ended after the rule cleared it, and the new session, its account and the flag stay
    expect(ended).toEqual([BLOB]);
    expect(main).toEqual({ session: NEW_BLOB, uiState: NEW_UI_STATE, wallet: null });
    expect(presence.state).toBe('present');
    expect(presence.calls).not.toContain('clear');
    expect(metrics.counted('session_window.signout_result')).toEqual([{ outcome: 'told_phone', reason: 'unnotified' }]);
  });

  it('As a user in a sign-out window whose core could not tell the phone, I sign out and it reports that, clears anyway and closes', async () => {
    // Given a stored session whose end on the core fails
    const { run, main, calls, metrics, errors } = openSignOutWindow({
      session: BLOB,
      failures: { end: new Error('core down') },
    });

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
    const { run, main, ended, calls, metrics, errors } = openSignOutWindow({
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
    const { run, main, calls, metrics } = openSignOutWindow({ session: BLOB, failures: { session: true } });

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
    const { run, main, calls, metrics } = openSignOutWindow({
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

  it.each([
    { outcome: 'told_phone', options: { session: BLOB }, last: 'signed out' },
    { outcome: 'cleared', options: { session: BLOB, notified: true }, last: 'close' },
    { outcome: 'nothing', options: {}, last: 'close' },
    { outcome: 'error', options: { session: BLOB, failures: { end: new Error('core down') } }, last: 'close' },
  ] satisfies { outcome: string; options: Params; last: string }[])(
    'As a user in a sign-out window that ends as $outcome, I sign out and every signed-in site is forgotten before the window closes or says I am signed out',
    async ({ outcome, options, last }) => {
      // Given a sign-out window whose sign-out ends as the outcome says
      const { run, calls } = openSignOutWindow(options);

      // When the sign-out flow runs
      const ended = await run();

      // Then the grants were forgotten once, after the store was read and before the window's last step
      expect(ended).toBe(outcome);
      expect(calls.filter(call => call === 'forget grants')).toHaveLength(1);
      expect(calls.indexOf('read')).toBeLessThan(calls.indexOf('forget grants'));
      expect(calls.slice(-2)).toEqual(['forget grants', last]);
    },
  );

  it.each([
    { outcome: 'told_phone', options: { session: BLOB }, last: 'signed out' },
    { outcome: 'cleared', options: { session: BLOB, notified: true }, last: 'close' },
    { outcome: 'nothing', options: {}, last: 'close' },
    { outcome: 'error', options: { session: BLOB, failures: { end: new Error('core down') } }, last: 'close' },
    { outcome: 'kept', options: { flag: 'present', session: BLOB }, last: 'close' },
  ] satisfies { outcome: string; options: Params; last: string }[])(
    'As a site that opened the sign-out window, I see it end as $outcome and no signed-in site is forgotten',
    async ({ outcome, options, last }) => {
      // Given a sign-out window whose first vetting is no page of dot.li, and whose sign-out ends as the outcome says
      const { run, calls } = openSignOutWindow({ ...options, firstParty: Promise.resolve(false) });

      // When the sign-out flow runs
      const ended = await run();

      // Then no grant was forgotten, and the window still took its last step
      expect(ended).toBe(outcome);
      expect(calls).not.toContain('forget grants');
      expect(calls.at(-1)).toBe(last);
    },
  );

  it('As an operator, I see a sign-out window whose grants could not be forgotten reported, and its outcome and close unchanged', async () => {
    // Given a stored session the page told the phone about, whose grants cannot be forgotten
    const failure = new Error('grants database blocked');
    const { run, main, calls, metrics, captures } = openSignOutWindow({
      notified: true,
      session: BLOB,
      failures: { grants: failure },
    });

    // When the sign-out flow runs
    const ended = await run();

    // Then the failure is reported and counted as a forget that failed, while the store is cleared, counted cleared and
    // the window closes
    expect(captures.exception).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        step: 'session_window_signout',
        tags: { reason: 'grants' },
      }),
    );
    expect(metrics.counted('session_pages.site_revoke')).toEqual([{ outcome: 'error', reason: 'sign_out' }]);
    expect(ended).toBe('cleared');
    expect(main.session).toBeNull();
    expect(calls.at(-1)).toBe('close');
    expect(metrics.counted('session_window.signout_result')).toEqual([{ outcome: 'cleared', reason: 'notified' }]);
  });
});
