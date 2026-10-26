// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { SHARED_CORE_SESSION_KEY, type LocalWalletReadResult } from '@dotli/protocol';
import { memoryStorage } from '@dotli/shared/testing';
import { createCoreStorage } from './core-storage.js';
import { pageSignInFlag } from './sign-in-flag.js';
import { createFakeSharedSessionStore, type FakeSharedSessionStore } from './core-storage.fake.js';
import { createFakeSessionPresence, type FakeSessionPresence } from './presence.fake.js';
import { createPagePresence } from './presence.js';
import { reconcileWithPresence, type RestoreStore } from './restore-rule.js';

const SESSION_KEY = SHARED_CORE_SESSION_KEY;
const UI_STATE_CACHE_KEY = `${SHARED_CORE_SESSION_KEY}:ui-state`;
const CACHED_UI_STATE = JSON.stringify({ connected: true, liteUsername: 'pgherveou.04' });
const DEAD = '0x010203';
const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

/** The frame's local wallet as the rule reads it. */
type FakeWallet = {
  record: { entropy: Uint8Array; version: Uint8Array } | null;
  readError: Error | null;
};

let shared: FakeSharedSessionStore;
let presence: FakeSessionPresence;
let wallet: FakeWallet;
let store: RestoreStore;

let saves = 0;

/** A save as the frame makes it, with a fresh version each time. */
function saveWallet(entropy: Uint8Array): void {
  saves += 1;
  wallet.record = { entropy, version: Uint8Array.of(saves) };
}

function walletRead(): LocalWalletReadResult {
  return wallet.record === null ? { status: 'none' } : { status: 'ok', ...wallet.record, identity: null };
}

/** Reads the flag as `reads` says, one value per read, then as the fake's state. */
function flagReads(...reads: FakeSessionPresence['state'][]): void {
  const read = presence.read.bind(presence);
  presence.read = () => {
    const next = reads.shift();
    if (next === undefined) {
      return read();
    }
    presence.calls.push('read');
    return Promise.resolve(next);
  };
}

beforeEach(() => {
  shared = createFakeSharedSessionStore('available');
  presence = createFakeSessionPresence('present');
  wallet = { record: null, readError: null };
  const coreStorage = createCoreStorage({
    shared,
    flag: pageSignInFlag({ presence, storedSignIn: () => Promise.resolve('none') }),
    local: () => memoryStorage(),
    keyDb: () => new IDBFactory(),
  });
  store = {
    readSession: () => coreStorage.readSession(),
    dropSessionIf: blob => coreStorage.dropSessionIf(blob),
    readWallet: () => (wallet.readError === null ? Promise.resolve(walletRead()) : Promise.reject(wallet.readError)),
  };
});

describe('the restore rule', () => {
  it('As a page whose cookie is present, I keep what is stored and clear nothing', async () => {
    // Given a stored session and wallet with the cookie present
    shared.entries.set(SESSION_KEY, DEAD);
    saveWallet(ENTROPY);

    // When the rule runs on load
    const restored = await reconcileWithPresence({ presence, store }, 'load');

    // Then both are kept and nothing is dead
    expect(restored).toEqual({
      presence: 'present',
      session: { status: 'ok', blob: DEAD },
      wallet: { status: 'ok', entropy: ENTROPY, identity: null, version: Uint8Array.of(saves) },
      dead: null,
    });
    expect(shared.entries.get(SESSION_KEY)).toBe(DEAD);
    expect(wallet.record?.entropy).toEqual(ENTROPY);
  });

  it('As a page whose cookie is gone, I drop the stored session with its account, keep the local wallet and count once', async () => {
    // Given a stored session, its account and a wallet with the cookie gone
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    shared.entries.set(SESSION_KEY, DEAD);
    shared.entries.set(UI_STATE_CACHE_KEY, CACHED_UI_STATE);
    saveWallet(ENTROPY);
    presence.state = 'absent';

    // When the rule runs on load
    const restored = await reconcileWithPresence({ presence, store }, 'load');

    // Then the session and account are dropped, the wallet kept and the drop counted once
    expect(restored).toEqual({
      presence: 'absent',
      session: { status: 'ok', blob: null },
      wallet: { status: 'ok', entropy: ENTROPY, identity: null, version: Uint8Array.of(saves) },
      dead: { blob: DEAD, cleared: 'dropped' },
    });
    expect(shared.entries.has(SESSION_KEY)).toBe(false);
    expect(shared.entries.has(UI_STATE_CACHE_KEY)).toBe(false);
    expect(wallet.record?.entropy).toEqual(ENTROPY);
    expect(metrics.counted('session.presence')).toEqual([{ outcome: 'dropped', reason: 'load' }]);
    expect(presence.calls).toEqual(['read', 'read']);
  });

  it('As a developer whose cookie is gone with only a local wallet stored, I keep the wallet, read the flag once and count nothing', async () => {
    // Given only a local wallet stored with the cookie gone
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    saveWallet(ENTROPY);
    presence.state = 'absent';

    // When the rule runs on load
    const restored = await reconcileWithPresence({ presence, store }, 'load');

    // Then the wallet is kept, the flag read once and nothing counted
    expect(restored).toEqual({
      presence: 'absent',
      session: { status: 'ok', blob: null },
      wallet: { status: 'ok', entropy: ENTROPY, identity: null, version: Uint8Array.of(saves) },
      dead: null,
    });
    expect(wallet.record?.entropy).toEqual(ENTROPY);
    expect(presence.calls).toEqual(['read']);
    expect(metrics.counted('session.presence')).toEqual([]);
  });

  it('As a page becoming visible or a window, I count what I drop under my own name', async () => {
    // Given the cookie gone
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    presence.state = 'absent';

    // When a dead session is stored and dropped once on visible and once in a window
    shared.entries.set(SESSION_KEY, DEAD);
    await reconcileWithPresence({ presence, store }, 'visible');
    shared.entries.set(SESSION_KEY, DEAD);
    await reconcileWithPresence({ presence, store }, 'window');

    // Then each drop is counted under its reader
    expect(metrics.counted('session.presence')).toEqual([
      { outcome: 'dropped', reason: 'visible' },
      { outcome: 'dropped', reason: 'window' },
    ]);
  });

  it('As a page whose cookie cannot be read, I keep what is stored', async () => {
    // Given a stored session and wallet with a flag that reads unknown
    shared.entries.set(SESSION_KEY, DEAD);
    saveWallet(ENTROPY);
    presence.state = 'unknown';

    // When the rule runs on load
    const restored = await reconcileWithPresence({ presence, store }, 'load');

    // Then both are kept and nothing is dead
    expect(restored.presence).toBe('unknown');
    expect(restored.session).toEqual({ status: 'ok', blob: DEAD });
    expect(restored.dead).toBeNull();
    expect(shared.entries.get(SESSION_KEY)).toBe(DEAD);
    expect(wallet.record?.entropy).toEqual(ENTROPY);
  });

  it('As a page whose flag read fails, I keep what is stored and leave a breadcrumb', async () => {
    // Given a stored session whose flag read rejects
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const failure = new Error('cookie jar exploded');
    const unreadable = createPagePresence({
      shared: () => true,
      localhost: false,
      channel: () => {
        throw new Error('no dev store on a deployed page');
      },
      jar: {
        read: () => {
          throw failure;
        },
        write: () => undefined,
      },
    });
    shared.entries.set(SESSION_KEY, DEAD);

    // When the rule runs on load
    const restored = await reconcileWithPresence({ presence: unreadable, store }, 'load');

    // Then the session is kept and the miss left as a breadcrumb
    expect(restored.presence).toBe('unknown');
    expect(shared.entries.get(SESSION_KEY)).toBe(DEAD);
    expect(captures.expected).toHaveBeenCalledWith(failure, { flow: 'wallet', step: 'presence_read' });
  });

  it('As a page that holds nothing, I read the flag once and clear nothing', async () => {
    // Given an empty store with the cookie gone
    presence.state = 'absent';

    // When the rule runs on load
    const restored = await reconcileWithPresence({ presence, store }, 'load');

    // Then nothing is stored or dead
    expect(restored).toEqual({
      presence: 'absent',
      session: { status: 'ok', blob: null },
      wallet: { status: 'none' },
      dead: null,
    });
    expect(presence.calls).toEqual(['read']);
  });

  it('As a page reading while a sign-in elsewhere sets the cookie and stores, I keep the new sign-in', async () => {
    // Given the flag gone as the store is read, and set again by a sign-in by the time it is read again
    shared.entries.set(SESSION_KEY, DEAD);
    flagReads('absent', 'present');

    // When the rule runs on load
    const restored = await reconcileWithPresence({ presence, store }, 'load');

    // Then the new sign-in is kept
    expect(restored).toEqual({
      presence: 'present',
      session: { status: 'ok', blob: DEAD },
      wallet: { status: 'none' },
      dead: null,
    });
    expect(shared.entries.get(SESSION_KEY)).toBe(DEAD);
  });

  it('As a page dropping a dead session, I keep a session another tab stores between my read and my clear', async () => {
    // Given the flag gone on both reads, and another tab's sign-in landing right after the second
    shared.entries.set(SESSION_KEY, DEAD);
    shared.entries.set(UI_STATE_CACHE_KEY, CACHED_UI_STATE);
    const read = presence.read.bind(presence);
    presence.read = async () => {
      const flag = await read();
      if (presence.calls.length === 2) {
        shared.changeFromOtherTab(SESSION_KEY, '0x0a0b0c');
      }
      return flag;
    };
    presence.state = 'absent';

    // When the rule runs on load
    const restored = await reconcileWithPresence({ presence, store }, 'load');

    // Then the new sign-in stays with its account, and the dead one reads as none but is kept to end
    expect(restored.session).toEqual({ status: 'ok', blob: null });
    expect(restored.dead).toEqual({ blob: DEAD, cleared: 'none' });
    expect(shared.entries.get(SESSION_KEY)).toBe('0x0a0b0c');
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBe(CACHED_UI_STATE);
  });

  it('As a page whose store keeps a dead session, I read none and the failure is counted as a failed drop', async () => {
    // Given a dead session the store refuses to drop
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    shared.entries.set(SESSION_KEY, DEAD);
    shared.clearError = () => new Error('store refused');
    presence.state = 'absent';

    // When the rule runs on load
    const restored = await reconcileWithPresence({ presence, store }, 'load');

    // Then no session is read and the failed drop is reported and counted
    expect(restored.session).toEqual({ status: 'ok', blob: null });
    expect(restored.dead).toEqual({ blob: DEAD, cleared: 'failed' });
    expect(captures.expected).toHaveBeenCalledWith(expect.any(Error), { flow: 'storage', step: 'session_drop' });
    expect(metrics.counted('session.presence')).toEqual([{ outcome: 'error', reason: 'load' }]);
  });

  it('As a page whose wallet cannot be read, I still drop a dead session and hand back why the wallet failed', async () => {
    // Given a dead session beside a wallet that cannot be read
    const failure = new Error('frame unavailable');
    shared.entries.set(SESSION_KEY, DEAD);
    wallet.readError = failure;
    presence.state = 'absent';

    // When the rule runs on load
    const restored = await reconcileWithPresence({ presence, store }, 'load');

    // Then the session is dropped and the wallet failure handed back
    expect(restored.wallet).toEqual({ status: 'failed', error: failure });
    expect(restored.dead?.cleared).toBe('dropped');
    expect(shared.entries.has(SESSION_KEY)).toBe(false);
  });

  it('As a page whose store cannot be read, I hand back the failure and clear nothing', async () => {
    // Given a dead session in a store that cannot be read
    const failure = new Error('protocol iframe never listened');
    shared.entries.set(SESSION_KEY, DEAD);
    shared.readError = failure;
    presence.state = 'absent';

    // When the rule runs on load
    const restored = await reconcileWithPresence({ presence, store }, 'load');

    // Then the read failure is handed back and nothing is cleared
    expect(restored.session).toEqual({ status: 'failed', error: failure });
    expect(restored.dead).toBeNull();
    expect(shared.clears).toEqual([]);
  });
});
