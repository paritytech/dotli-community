// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { atom } from 'nanostores';
import { bindReports } from '../testing/bindReports.js';
import type { WalletModeState } from './state/walletModeState.js';
import type { PageRole } from './pageRole.js';
import { createWalletBoot } from './createWalletBoot.js';
import type { Presence } from './session/types.js';
import type { SessionRead } from './session/createCoreStorage.js';
import type { PresenceReader, Reconciled } from './session/restoreRule.js';
import type { WalletRead } from './session/siteWallet.js';

type BuildReconciledParams = {
  /** The flag the rule read, present by default. */
  presence?: Presence;
  /** The session left, as a blob or a read, none by default. */
  session?: string | null | SessionRead;
};

type CreateBootHarnessParams = {
  /** What the restore rule answers on each pass. */
  answer: () => Reconciled;
  /** The page's role, a product page by default. */
  role?: PageRole;
};

const ENTROPY = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const WALLET = { status: 'ok' as const, entropy: ENTROPY, identity: null, version: Uint8Array.of(1) };
const STORE_DOWN = { status: 'failed' as const, error: new Error('store down') };

/** What the restore rule leaves: the wallet the frame answered, the flag it read and the session left. */
function buildReconciled(
  wallet: WalletRead,
  { presence = 'present', session = null }: BuildReconciledParams = {},
): Reconciled {
  const read: SessionRead = typeof session === 'object' && session !== null ? session : { status: 'ok', blob: session };
  return { presence, session: read, wallet, dead: null };
}

/** What the restore rule leaves when the protocol frame cannot answer. */
function buildFrameDown(): Reconciled {
  return buildReconciled({ status: 'failed', error: new Error('frame unavailable') });
}

/**
 * A wallet boot over a restore rule that answers with `answer`, reporting into a fresh wallet mode store, with a fake
 * Sentry and capture sink bound for this test.
 */
function createBootHarness({ answer, role = 'page' }: CreateBootHarnessParams) {
  const { captures, counted } = bindReports();
  const reconcile = vi.fn((_reader: PresenceReader) => Promise.resolve(answer()));
  const flag = { renew: vi.fn() };
  const mode = atom<WalletModeState>({ mode: 'app', failure: null });
  const walletBoot = createWalletBoot({
    reconcile,
    report: value => {
      mode.set(value);
    },
    flag,
    role,
  });
  return { reconcile, flag, mode, walletBoot, captures, counted };
}

describe('wallet boot', () => {
  it('As a user with a local wallet, I boot and get local mode with its entropy', async () => {
    // Given a restore rule that finds my local wallet
    const { mode, walletBoot } = createBootHarness({ answer: () => buildReconciled(WALLET) });

    // When a core reads the wallet
    const boot = await walletBoot.read();

    // Then it gets the wallet and the page is in local mode
    expect(boot).toEqual(WALLET);
    expect(mode.get()).toEqual({ mode: 'local', failure: null });
  });

  it('As a Polkadot App user, I boot and get the pairing host', async () => {
    // Given a restore rule that finds no local wallet
    const { mode, walletBoot } = createBootHarness({ answer: () => buildReconciled({ status: 'none' }) });

    // When a core reads the wallet
    const boot = await walletBoot.read();

    // Then it gets none and the page pairs with no failure shown
    expect(boot).toBeNull();
    expect(mode.get()).toEqual({ mode: 'app', failure: null });
  });

  it('As a user whose wallet no longer decrypts, I boot the pairing host and am told why', async () => {
    // Given a restore rule that finds a wallet it cannot decrypt
    const { mode, walletBoot, captures } = createBootHarness({
      answer: () => buildReconciled({ status: 'unreadable' }),
    });

    // When a core reads the wallet
    const boot = await walletBoot.read();

    // Then the page pairs, shows why and reports the failure
    expect(boot).toBeNull();
    expect(mode.get().mode).toBe('app');
    expect(mode.get().failure).toMatch(/could not be decrypted/);
    expect(captures.exception).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        step: 'local_wallet',
        tags: { reason: 'unreadable' },
      }),
    );
  });

  it('As a Polkadot App user whose protocol frame never came up, I boot and still get the pairing host', async () => {
    // Given a restore rule whose wallet read failed as the frame never came up
    const failure = new Error('frame unavailable');
    const { mode, walletBoot, captures } = createBootHarness({
      answer: () => buildReconciled({ status: 'failed', error: failure }),
    });

    // When a core reads the wallet
    const boot = await walletBoot.read();

    // Then the page pairs, shows that the wallet could not be read and records it as expected
    expect(boot).toBeNull();
    expect(mode.get().mode).toBe('app');
    expect(mode.get().failure).toMatch(/could not be read/);
    expect(captures.expected).toHaveBeenCalledWith(failure, expect.objectContaining({ step: 'local_wallet' }));
  });

  it('As a user on a page with several cores, I boot and the restore rule runs once', async () => {
    // Given a page whose restore finds nothing stored
    const { reconcile, walletBoot } = createBootHarness({ answer: () => buildReconciled({ status: 'none' }) });

    // When its cores read and restore together, and one reads again
    await Promise.all([walletBoot.read(), walletBoot.restore()]);
    await walletBoot.read();

    // Then the rule ran once
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('As a local wallet user whose shared store came back, I read again and my local wallet is restored', async () => {
    // Given a first restore the frame could not answer, then the frame back with the wallet
    let frameUp = false;
    const { reconcile, mode, walletBoot } = createBootHarness({
      answer: () => (frameUp ? buildReconciled(WALLET) : buildFrameDown()),
    });
    const firstBoot = await walletBoot.read();
    frameUp = true;

    // When a core reads again
    const boot = await walletBoot.read();

    // Then the second read runs the rule again and gets the wallet in local mode
    expect(firstBoot).toBeNull();
    expect(boot).toEqual(WALLET);
    expect(mode.get()).toEqual({ mode: 'local', failure: null });
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('As a Polkadot App user whose shared store came back, I read again and am no longer told my wallet could not be read', async () => {
    // Given a first restore the frame could not answer, then the frame back with no wallet
    let frameUp = false;
    const { mode, walletBoot } = createBootHarness({
      answer: () => (frameUp ? buildReconciled({ status: 'none' }) : buildFrameDown()),
    });
    await walletBoot.read();
    frameUp = true;

    // When a core reads again
    const boot = await walletBoot.read();

    // Then it gets none and the failure is gone
    expect(boot).toBeNull();
    expect(mode.get()).toEqual({ mode: 'app', failure: null });
  });

  it('As a user whose protocol frame is down, I boot two cores together and the queued read applies the rule again', async () => {
    // Given a protocol frame that cannot answer
    const { reconcile, walletBoot } = createBootHarness({ answer: buildFrameDown });

    // When two cores read together
    const boots = await Promise.all([walletBoot.read(), walletBoot.read()]);

    // Then neither boots a wallet and the second read applies the rule again
    expect(boots).toEqual([null, null]);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('As an operator, I see each pass that met a protocol frame that cannot answer as a breadcrumb and a count, not an issue', async () => {
    // Given a protocol frame that cannot answer, with metrics recorded
    const { walletBoot, captures, counted } = createBootHarness({ answer: buildFrameDown });

    // When the page reads twice
    await walletBoot.read();
    await walletBoot.read();

    // Then nothing is an issue and each pass is a breadcrumb and a count
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledTimes(2);
    expect(counted('wallet.local_activate')).toEqual([
      { outcome: 'error', reason: 'read' },
      { outcome: 'error', reason: 'read' },
    ]);
  });

  it('As a local wallet user whose session read failed on load, I read again and the rule applies again', async () => {
    // Given a first restore whose session read the store could not answer, then the store back
    let storeUp = false;
    const { reconcile, mode, walletBoot } = createBootHarness({
      answer: () => (storeUp ? buildReconciled(WALLET) : buildReconciled(WALLET, { session: STORE_DOWN })),
    });
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

  it('As an operator, I watch a page whose session read failed on load restore later and see an unreadable cookie counted once', async () => {
    // Given a cookie that reads unknown and a store that is down until the second read
    let storeUp = false;
    const { walletBoot, counted } = createBootHarness({
      answer: () => buildReconciled({ status: 'none' }, { presence: 'unknown', session: storeUp ? null : STORE_DOWN }),
    });
    await walletBoot.read();
    storeUp = true;

    // When two cores read
    await walletBoot.read();
    await walletBoot.read();

    // Then the unreadable cookie is counted once
    expect(counted('session.presence')).toEqual([{ outcome: 'unreadable', reason: 'load' }]);
  });

  it("As a local wallet user whose session read failed on load, I read again while a retry's wallet read fails and stay in my mode", async () => {
    // Given a first pass that read the wallet but not the session, then one that read the session but not the wallet
    const passes = [buildReconciled(WALLET, { session: STORE_DOWN }), buildFrameDown(), buildReconciled(WALLET)];
    const { reconcile, mode, walletBoot, captures } = createBootHarness({
      answer: () => passes[reconcile.mock.calls.length - 1] ?? buildFrameDown(),
    });
    await walletBoot.read();

    // When a core reads again
    const retried = await walletBoot.read();

    // Then the first answered wallet still tells the mode, with no outage reported
    expect(retried).toEqual(WALLET);
    expect(mode.get()).toEqual({ mode: 'local', failure: null });
    expect(captures.exception).not.toHaveBeenCalled();
  });

  it('As an operator, I watch an unreadable wallet first answered with a failed session read and see it reported once', async () => {
    // Given a wallet that reads unreadable, first with a failed session read
    const { reconcile, walletBoot, captures } = createBootHarness({
      answer: () =>
        reconcile.mock.calls.length === 1
          ? buildReconciled({ status: 'unreadable' }, { session: STORE_DOWN })
          : buildReconciled({ status: 'unreadable' }),
    });

    // When two cores read
    await walletBoot.read();
    await walletBoot.read();

    // Then the unreadable wallet was reported once
    expect(captures.exception).toHaveBeenCalledTimes(1);
  });

  it('As a user in the sign-out window, I sign out and a session the first boot pass dropped counts as cleared', async () => {
    // Given a first pass that dropped the dead session but could not read the wallet, then one that finds it gone
    const deadBlob = '0xdead-session';
    const first: Reconciled = { ...buildFrameDown(), presence: 'absent', dead: { blob: deadBlob, cleared: 'dropped' } };
    const { reconcile, walletBoot } = createBootHarness({
      answer: () =>
        reconcile.mock.calls.length === 1 ? first : buildReconciled({ status: 'none' }, { presence: 'absent' }),
    });
    await walletBoot.restore();

    // When the restore is asked again, and once more
    const kept = await walletBoot.restore();
    const again = await walletBoot.restore();

    // Then the window still has the blob to end and counts it as cleared
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(kept.dead).toEqual({ blob: deadBlob, cleared: 'dropped' });
    expect(again).toBe(kept);
  });

  it('As a user in the sign-in window with a stored local wallet, I boot the pairing host and keep the wallet', async () => {
    // Given the sign-in window's boot over a stored local wallet
    const { mode, walletBoot } = createBootHarness({ answer: () => buildReconciled(WALLET), role: 'signin-window' });

    // When its core reads
    const boot = await walletBoot.read();
    const restoredWallet = (await walletBoot.restore()).wallet;

    // Then it boots in app mode and the restore still holds the wallet
    expect(boot).toBeNull();
    expect(mode.get()).toEqual({ mode: 'app', failure: null });
    expect(restoredWallet).toEqual(WALLET);
  });

  it('As a user in the session window serving a site, I boot on the stored local wallet and the mode reads local', async () => {
    // Given the sign-in window's boot over a stored local wallet, whose load already read it as data
    const { mode, walletBoot } = createBootHarness({ answer: () => buildReconciled(WALLET), role: 'signin-window' });
    await walletBoot.restore();

    // When the window serves a site and its core reads
    walletBoot.serveSites();
    const boot = await walletBoot.read();

    // Then it boots the wallet and the mode reads local
    expect(boot).toEqual(WALLET);
    expect(mode.get()).toEqual({ mode: 'local', failure: null });
  });

  it('As a user in the session window serving a site over a wallet that no longer decrypts, I boot and am told why, with the failure reported once', async () => {
    // Given the sign-in window's boot over an unreadable wallet, which its load already reported
    const { mode, walletBoot, captures } = createBootHarness({
      answer: () => buildReconciled({ status: 'unreadable' }),
      role: 'signin-window',
    });
    await walletBoot.restore();

    // When the window serves a site and its core reads
    walletBoot.serveSites();
    const boot = await walletBoot.read();

    // Then it pairs, the failure stays on show and was reported once
    expect(boot).toBeNull();
    expect(mode.get().failure).toMatch(/could not be decrypted/);
    expect(captures.exception).toHaveBeenCalledTimes(1);
  });

  it("As a user in the session window for dot.li's own page, I boot and the stored wallet stays data while the window pairs", async () => {
    // Given the sign-in window's boot over a stored local wallet, serving no site
    const { walletBoot } = createBootHarness({ answer: () => buildReconciled(WALLET), role: 'signin-window' });

    // When its core reads
    const boot = await walletBoot.read();

    // Then it pairs
    expect(boot).toBeNull();
  });

  it('As a dotli integrator, I boot a page and a window and the page applies the rule as a load while the window applies it as a window', async () => {
    // Given a page's boot and a sign-out window's boot
    const page = createBootHarness({ answer: () => buildReconciled({ status: 'none' }) });
    const window = createBootHarness({ answer: () => buildReconciled({ status: 'none' }), role: 'signout-window' });

    // When both read
    await Promise.all([page.walletBoot.read(), window.walletBoot.read()]);

    // Then each applies the rule under its own reader
    expect(page.reconcile).toHaveBeenCalledWith('load');
    expect(window.reconcile).toHaveBeenCalledWith('window');
  });

  it('As a user whose cookie cannot be read, I boot on what is stored and the miss is counted once', async () => {
    // Given a boot over a stored wallet whose cookie reads unknown
    const { walletBoot, counted } = createBootHarness({
      answer: () => buildReconciled(WALLET, { presence: 'unknown' }),
    });

    // When two cores read
    const boot = await walletBoot.read();
    await walletBoot.read();

    // Then the wallet is kept and the miss counted once
    expect(boot).toEqual(WALLET);
    expect(counted('session.presence')).toEqual([{ outcome: 'unreadable', reason: 'load' }]);
  });

  it('As a user on a preview its preview host frames, I boot with the flag unknown by design and no miss is counted', async () => {
    // Given a framed preview's boot whose flag reads unknown
    const { walletBoot, counted } = createBootHarness({
      answer: () => buildReconciled({ status: 'none' }, { presence: 'unknown', session: 'aa' }),
      role: 'framed-preview',
    });

    // When its core reads
    await walletBoot.read();

    // Then nothing is counted
    expect(counted('session.presence')).toEqual([]);
  });

  it('As a user signed in on load, I boot and the flag is renewed through its keeper so it lives on', async () => {
    // Given a boot over a stored session whose flag is present
    const { flag, walletBoot } = createBootHarness({
      answer: () => buildReconciled({ status: 'none' }, { session: 'aa' }),
    });

    // When its cores read
    await walletBoot.read();
    await walletBoot.read();

    // Then the keeper was asked once to renew the flag
    expect(flag.renew).toHaveBeenCalledTimes(1);
  });

  it('As a user whose flag is gone or unreadable or whose page holds nothing, I boot and the flag is never renewed', async () => {
    // Given boots with the flag gone, unreadable, or present over nothing
    const gone = createBootHarness({ answer: () => buildReconciled({ status: 'none' }, { presence: 'absent' }) });
    const unreadable = createBootHarness({ answer: () => buildReconciled(WALLET, { presence: 'unknown' }) });
    const empty = createBootHarness({ answer: () => buildReconciled({ status: 'none' }) });

    // When each core reads
    await Promise.all([gone.walletBoot.read(), unreadable.walletBoot.read(), empty.walletBoot.read()]);

    // Then none renewed the flag
    expect([gone.flag.renew, unreadable.flag.renew, empty.flag.renew].map(renew => renew.mock.calls.length)).toEqual([
      0, 0, 0,
    ]);
  });

  it('As a user on the landing page, I load it and the rule applies as a load while a stored local wallet boots local mode', async () => {
    // Given the landing page's boot over a stored local wallet
    const { mode, reconcile, walletBoot } = createBootHarness({
      answer: () => buildReconciled(WALLET),
      role: 'landing',
    });

    // When its core reads
    const boot = await walletBoot.read();

    // Then the rule applies as a load and the page boots local mode
    expect(reconcile).toHaveBeenCalledWith('load');
    expect(boot).toEqual(WALLET);
    expect(mode.get().mode).toBe('local');
  });

  it('As a user on a preview its preview host frames, I boot with a stored local wallet and get local mode', async () => {
    // Given a framed preview's boot over a stored local wallet
    const { mode, walletBoot } = createBootHarness({
      answer: () => buildReconciled(WALLET, { presence: 'unknown' }),
      role: 'framed-preview',
    });

    // When its core reads
    const boot = await walletBoot.read();

    // Then the page boots local mode
    expect(boot).toEqual(WALLET);
    expect(mode.get().mode).toBe('local');
  });
});
