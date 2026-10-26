// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { createSyncStore } from '@dotli/shared';
import type { WalletModeState } from './state/wallet-mode.js';
import type { PageRole } from './page-role.js';
import { createWalletBoot } from './wallet-boot.js';
import type { Presence } from './session/presence.js';
import type { SessionRead } from './session/core-storage.js';
import type { PresenceReader, Reconciled } from './session/restore-rule.js';
import type { WalletRead } from './session/site-wallet.js';

const captures = { exception: vi.fn(), expected: vi.fn() };

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const WALLET = { status: 'ok' as const, entropy: ENTROPY, identity: null, version: Uint8Array.of(1) };

/** What the restore rule leaves: the wallet the frame answered, the flag it read and the session left. */
function restored(
  wallet: WalletRead,
  presence: Presence = 'present',
  session: string | null | SessionRead = null,
): Reconciled {
  const read: SessionRead = typeof session === 'object' && session !== null ? session : { status: 'ok', blob: session };
  return { presence, session: read, wallet, dead: null };
}

/** A wallet boot over a restore rule that answers with `answer`, reporting into a fresh wallet mode store. */
function bootWith(answer: () => Reconciled, role: PageRole = 'page') {
  const reconcile = vi.fn((_reader: PresenceReader) => Promise.resolve(answer()));
  const flag = { renew: vi.fn() };
  const mode = createSyncStore<WalletModeState>('walletMode', { mode: 'app', failure: null });
  const walletBoot = createWalletBoot({
    reconcile,
    report: mode.set,
    flag,
    role,
  });
  return { reconcile, flag, mode, walletBoot };
}

const frameDown = (): Reconciled => restored({ status: 'failed', error: new Error('frame unavailable') });

beforeEach(() => {
  vi.clearAllMocks();
  bindCaptureSink(captures);
});

describe('wallet boot', () => {
  it('As a user with a local wallet, I boot in local mode with its entropy', async () => {
    // Given
    const { mode, walletBoot } = bootWith(() => restored(WALLET));

    // When
    const boot = await walletBoot.read();

    // Then
    expect(boot).toEqual(WALLET);
    expect(mode.get()).toEqual({ mode: 'local', failure: null });
  });

  it('As a Polkadot App user, I boot the pairing host', async () => {
    // Given
    const { mode, walletBoot } = bootWith(() => restored({ status: 'none' }));

    // When
    const boot = await walletBoot.read();

    // Then
    expect(boot).toBeNull();
    expect(mode.get()).toEqual({ mode: 'app', failure: null });
  });

  it('As a user whose wallet no longer decrypts, I boot the pairing host and am told why', async () => {
    // Given
    const { mode, walletBoot } = bootWith(() => restored({ status: 'unreadable' }));

    // When
    const boot = await walletBoot.read();

    // Then
    expect(boot).toBeNull();
    expect(mode.get().mode).toBe('app');
    expect(mode.get().failure).toMatch(/could not be decrypted/);
    expect(captures.exception).toHaveBeenCalledWith(expect.any(Error), {
      flow: 'wallet',
      step: 'local_wallet',
      tags: { reason: 'unreadable' },
    });
  });

  it('As a Polkadot App user whose protocol frame never came up, I still boot the pairing host', async () => {
    // Given
    const failure = new Error('frame unavailable');
    const { mode, walletBoot } = bootWith(() => restored({ status: 'failed', error: failure }));

    // When
    const boot = await walletBoot.read();

    // Then
    expect(boot).toBeNull();
    expect(mode.get().mode).toBe('app');
    expect(mode.get().failure).toMatch(/could not be read/);
    expect(captures.expected).toHaveBeenCalledWith(failure, { flow: 'wallet', step: 'local_wallet' });
  });

  it('As a page with several cores, I apply the restore rule once', async () => {
    // Given a page whose restore finds nothing stored
    const { reconcile, walletBoot } = bootWith(() => restored({ status: 'none' }));

    // When its cores read and restore together, and one reads again
    await Promise.all([walletBoot.read(), walletBoot.restore()]);
    await walletBoot.read();

    // Then the rule ran once
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('As a local wallet user whose shared store came back, the next read restores my local wallet', async () => {
    // Given: a first restore the frame could not answer, then the frame back with the wallet
    let frameUp = false;
    const { reconcile, mode, walletBoot } = bootWith(() => (frameUp ? restored(WALLET) : frameDown()));
    expect(await walletBoot.read()).toBeNull();
    frameUp = true;

    // When
    const boot = await walletBoot.read();

    // Then
    expect(boot).toEqual(WALLET);
    expect(mode.get()).toEqual({ mode: 'local', failure: null });
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('As a Polkadot App user whose shared store came back, I am no longer told my wallet could not be read', async () => {
    // Given
    let frameUp = false;
    const { mode, walletBoot } = bootWith(() => (frameUp ? restored({ status: 'none' }) : frameDown()));
    await walletBoot.read();
    frameUp = true;

    // When
    const boot = await walletBoot.read();

    // Then
    expect(boot).toBeNull();
    expect(mode.get()).toEqual({ mode: 'app', failure: null });
  });

  it('As a page whose cores ask together while the frame is down, I queue the read and it applies the rule again', async () => {
    // Given a protocol frame that cannot answer
    const { reconcile, walletBoot } = bootWith(frameDown);

    // When two cores read together
    const boots = await Promise.all([walletBoot.read(), walletBoot.read()]);

    // Then neither boots a wallet and the second read applies the rule again
    expect(boots).toEqual([null, null]);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('As an operator, I see each pass that met a protocol frame that cannot answer as a breadcrumb and a count, not an issue', async () => {
    // Given a protocol frame that cannot answer, with metrics recorded
    const metrics: RecordingSentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { walletBoot } = bootWith(frameDown);

    // When the page reads twice
    await walletBoot.read();
    await walletBoot.read();

    // Then nothing is an issue and each pass is a breadcrumb and a count
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledTimes(2);
    expect(metrics.counted('wallet.local_activate')).toEqual([
      { outcome: 'error', reason: 'read' },
      { outcome: 'error', reason: 'read' },
    ]);
  });

  it('As a page whose session read failed on load, I read again and the rule applies again', async () => {
    // Given a first restore whose session read the store could not answer, then the store back
    let storeUp = false;
    const { reconcile, mode, walletBoot } = bootWith(() =>
      storeUp ? restored(WALLET) : restored(WALLET, 'present', { status: 'failed', error: new Error('store down') }),
    );
    const first = await walletBoot.read();
    storeUp = true;

    // When two cores read
    await walletBoot.read();
    await walletBoot.read();

    // Then the wallet still told the mode, and the rule ran again until both reads were answered
    expect(first).toEqual(WALLET);
    expect(mode.get()).toEqual({ mode: 'local', failure: null });
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('As a page whose session read failed on load, I keep a later restore and an unreadable cookie is counted then', async () => {
    // Given a cookie that reads unknown and a store that is down until the second read
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    let storeUp = false;
    const { walletBoot } = bootWith(() =>
      restored({ status: 'none' }, 'unknown', storeUp ? null : { status: 'failed', error: new Error('store down') }),
    );
    await walletBoot.read();
    storeUp = true;

    // When two cores read
    await walletBoot.read();
    await walletBoot.read();

    // Then the unreadable cookie is counted once
    expect(metrics.counted('session.presence')).toEqual([{ outcome: 'unreadable', reason: 'load' }]);
  });

  it("As a local wallet user whose session read failed on load, I stay in my mode when a retry's wallet read fails", async () => {
    // Given a first pass that read the wallet but not the session, then one that read the session but not the wallet
    const storeDown = { status: 'failed' as const, error: new Error('store down') };
    const passes = [restored(WALLET, 'present', storeDown), frameDown(), restored(WALLET)];
    const { reconcile, mode, walletBoot } = bootWith(() => passes[reconcile.mock.calls.length - 1] ?? frameDown());
    await walletBoot.read();

    // When a core reads again
    const retried = await walletBoot.read();

    // Then the first answered wallet still tells the mode, with no outage reported
    expect(retried).toEqual(WALLET);
    expect(mode.get()).toEqual({ mode: 'local', failure: null });
    expect(captures.exception).not.toHaveBeenCalled();
  });

  it('As a page whose unreadable wallet was answered with a failed session read, I report it once', async () => {
    // Given a wallet that reads unreadable, first with a failed session read
    const storeDown = { status: 'failed' as const, error: new Error('store down') };
    const { reconcile, walletBoot } = bootWith(() =>
      reconcile.mock.calls.length === 1
        ? restored({ status: 'unreadable' }, 'present', storeDown)
        : restored({ status: 'unreadable' }),
    );

    // When two cores read
    await walletBoot.read();
    await walletBoot.read();

    // Then
    expect(captures.exception).toHaveBeenCalledTimes(1);
  });

  it('As a user in the sign-out window, I sign out and a session the first boot pass dropped counts as cleared', async () => {
    // Given a first pass that dropped the dead session but could not read the wallet, then one that finds it gone
    const deadBlob = '0xdead-session';
    const first: Reconciled = { ...frameDown(), presence: 'absent', dead: { blob: deadBlob, cleared: 'dropped' } };
    const { reconcile, walletBoot } = bootWith(() =>
      reconcile.mock.calls.length === 1 ? first : restored({ status: 'none' }, 'absent'),
    );
    await walletBoot.restore();

    // When the restore is asked again
    const kept = await walletBoot.restore();

    // Then the window still has the blob to end and counts it as cleared
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(kept.dead).toEqual({ blob: deadBlob, cleared: 'dropped' });
    expect(await walletBoot.restore()).toBe(kept);
  });

  it('As a user in the sign-in window with a stored local wallet, I boot the pairing host and keep the wallet', async () => {
    // Given the sign-in window's boot over a stored local wallet
    const { mode, walletBoot } = bootWith(() => restored(WALLET), 'signin-window');

    // When its core reads
    const boot = await walletBoot.read();

    // Then it boots in app mode and the restore still holds the wallet
    expect(boot).toBeNull();
    expect(mode.get()).toEqual({ mode: 'app', failure: null });
    expect((await walletBoot.restore()).wallet).toEqual(WALLET);
  });

  it('As the session window serving a site, I boot on the stored local wallet and the mode reads local', async () => {
    // Given the sign-in window's boot over a stored local wallet, whose load already read it as data
    const { mode, walletBoot } = bootWith(() => restored(WALLET), 'signin-window');
    await walletBoot.restore();

    // When the window serves a site and its core reads
    walletBoot.serveSites();
    const boot = await walletBoot.read();

    // Then it boots the wallet and the mode reads local
    expect(boot).toEqual(WALLET);
    expect(mode.get()).toEqual({ mode: 'local', failure: null });
  });

  it('As the session window serving a site over a wallet that no longer decrypts, I am told once why', async () => {
    // Given the sign-in window's boot over an unreadable wallet, which its load already reported
    const { mode, walletBoot } = bootWith(() => restored({ status: 'unreadable' }), 'signin-window');
    await walletBoot.restore();

    // When the window serves a site and its core reads
    walletBoot.serveSites();
    const boot = await walletBoot.read();

    // Then it pairs, the failure stays on show and was reported once
    expect(boot).toBeNull();
    expect(mode.get().failure).toMatch(/could not be decrypted/);
    expect(captures.exception).toHaveBeenCalledTimes(1);
  });

  it("As the session window for dot.li's own page, I keep a stored wallet as data", async () => {
    // Given the sign-in window's boot over a stored local wallet, serving no site
    const { walletBoot } = bootWith(() => restored(WALLET), 'signin-window');

    // When its core reads
    const boot = await walletBoot.read();

    // Then it pairs
    expect(boot).toBeNull();
  });

  it('As a page, I apply the rule as a load, and a window applies it as a window', async () => {
    // Given a page's boot and a sign-out window's boot
    const page = bootWith(() => restored({ status: 'none' }));
    const window = bootWith(() => restored({ status: 'none' }), 'signout-window');

    // When both read
    await Promise.all([page.walletBoot.read(), window.walletBoot.read()]);

    // Then each applies the rule under its own reader
    expect(page.reconcile).toHaveBeenCalledWith('load');
    expect(window.reconcile).toHaveBeenCalledWith('window');
  });

  it('As a page whose cookie cannot be read, I keep what is stored and the miss is counted once', async () => {
    // Given a boot over a stored wallet whose cookie reads unknown
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { walletBoot } = bootWith(() => restored(WALLET, 'unknown'));

    // When two cores read
    const boot = await walletBoot.read();
    await walletBoot.read();

    // Then the wallet is kept and the miss counted once
    expect(boot).toEqual(WALLET);
    expect(metrics.counted('session.presence')).toEqual([{ outcome: 'unreadable', reason: 'load' }]);
  });

  it('As a page on a preview its preview host frames, I read the flag as unknown by design and count no miss', async () => {
    // Given a framed preview's boot whose flag reads unknown
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { walletBoot } = bootWith(() => restored({ status: 'none' }, 'unknown', 'aa'), 'framed-preview');

    // When its core reads
    await walletBoot.read();

    // Then nothing is counted
    expect(metrics.counted('session.presence')).toEqual([]);
  });

  it('As a page that finds itself signed in on load, I renew the flag through its keeper so it lives on', async () => {
    // Given a boot over a stored session whose flag is present
    const { flag, walletBoot } = bootWith(() => restored({ status: 'none' }, 'present', 'aa'));

    // When its cores read
    await walletBoot.read();
    await walletBoot.read();

    // Then the keeper was asked once to renew the flag
    expect(flag.renew).toHaveBeenCalledTimes(1);
  });

  it('As a page whose flag is gone or unreadable or that holds nothing, I boot and never renew the flag', async () => {
    // Given boots with the flag gone, unreadable, or present over nothing
    const gone = bootWith(() => restored({ status: 'none' }, 'absent'));
    const unreadable = bootWith(() => restored(WALLET, 'unknown'));
    const empty = bootWith(() => restored({ status: 'none' }, 'present'));

    // When each core reads
    await Promise.all([gone.walletBoot.read(), unreadable.walletBoot.read(), empty.walletBoot.read()]);

    // Then none renewed the flag
    expect([gone.flag.renew, unreadable.flag.renew, empty.flag.renew].map(renew => renew.mock.calls.length)).toEqual([
      0, 0, 0,
    ]);
  });

  it('As a user on the landing page, I load it and the rule applies as a load while a stored local wallet boots local mode', async () => {
    // Given the landing page's boot over a stored local wallet
    const { mode, reconcile, walletBoot } = bootWith(() => restored(WALLET), 'landing');

    // When its core reads
    const boot = await walletBoot.read();

    // Then the rule applies as a load and the page boots local mode
    expect(reconcile).toHaveBeenCalledWith('load');
    expect(boot).toEqual(WALLET);
    expect(mode.get().mode).toBe('local');
  });

  it('As a page on a preview its preview host frames, I boot local mode from a stored local wallet', async () => {
    // Given a framed preview's boot over a stored local wallet
    const { mode, walletBoot } = bootWith(() => restored(WALLET, 'unknown'), 'framed-preview');

    // When its core reads
    const boot = await walletBoot.read();

    // Then the page boots local mode
    expect(boot).toEqual(WALLET);
    expect(mode.get().mode).toBe('local');
  });
});
