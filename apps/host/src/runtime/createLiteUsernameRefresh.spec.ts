// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { bindReports } from '../testing/bindReports.js';
import { createLiteUsernameRefresh } from './createLiteUsernameRefresh.js';
import type { LocalWalletBoot } from './createWalletBoot.js';

type Params = {
  /** The People read of the user's name. */
  read: () => Promise<string | null>;
};

const IDENTITY_ACCOUNT = `0x${'11'.repeat(32)}`;
const ENTROPY = Uint8Array.from({ length: 16 }, (_, index) => index + 1);

/** The account a core reported once its local session was active. */
function readReportedAccount(): Promise<string> {
  return Promise.resolve(IDENTITY_ACCOUNT);
}

/** A refresh over a People read that answers with `read`, recording what it saves and reports. */
function createRefresh({ read }: Params) {
  const params = {
    readLiteUsername: vi.fn(read),
    saveIdentity: vi.fn((): Promise<void> => Promise.resolve()),
    reportFailure: vi.fn(),
  };
  return { ...params, liteUsername: createLiteUsernameRefresh(params) };
}

function buildWallet(liteUsername: string | null | undefined): LocalWalletBoot {
  return {
    status: 'ok',
    entropy: ENTROPY,
    identity: liteUsername === undefined ? null : { identityAccountId: IDENTITY_ACCOUNT, liteUsername },
    version: Uint8Array.of(1),
  };
}

describe('lite username refresh', () => {
  it('As a user on the first boot after import, I get my name from the network and it is cached', async () => {
    // Given a network that holds my name
    const { liteUsername, readLiteUsername, saveIdentity } = createRefresh({ read: () => Promise.resolve('alice.42') });

    // When the name is refreshed for a wallet with no cached identity
    const name = await liteUsername.refresh(buildWallet(undefined), readReportedAccount());

    // Then the name is read for the reported account and cached
    expect(name).toBe('alice.42');
    expect(readLiteUsername).toHaveBeenCalledWith(IDENTITY_ACCOUNT);
    expect(saveIdentity).toHaveBeenCalledWith({ identityAccountId: IDENTITY_ACCOUNT, liteUsername: 'alice.42' });
  });

  it('As a user whose cached name is current, I am not re-activated and nothing is written', async () => {
    // Given a network that holds the cached name
    const { liteUsername, saveIdentity } = createRefresh({ read: () => Promise.resolve('alice.42') });

    // When the name is refreshed
    const name = await liteUsername.refresh(buildWallet('alice.42'), readReportedAccount());

    // Then no new name comes back and nothing is saved
    expect(name).toBeUndefined();
    expect(saveIdentity).not.toHaveBeenCalled();
  });

  it('As a user without a lite username, I am told so once and keep no name', async () => {
    // Given a network that holds no name for me
    const { liteUsername, saveIdentity } = createRefresh({ read: () => Promise.resolve(null) });

    // When the name is refreshed
    const name = await liteUsername.refresh(buildWallet(undefined), readReportedAccount());

    // Then no name comes back and its absence is cached
    expect(name).toBeUndefined();
    expect(saveIdentity).toHaveBeenCalledWith({ identityAccountId: IDENTITY_ACCOUNT, liteUsername: null });
  });

  it('As a user whose network read failed, I refresh my name and keep my cached one', async () => {
    // Given a network read that fails
    const { liteUsername, saveIdentity } = createRefresh({
      read: () => Promise.reject(new Error('people unavailable')),
    });

    // When the name is refreshed
    const name = await liteUsername.refresh(buildWallet('alice.42'), readReportedAccount());

    // Then no new name comes back and nothing is saved
    expect(name).toBeUndefined();
    expect(saveIdentity).not.toHaveBeenCalled();
  });

  it('As a user whose network read failed, I boot the next core on the page and it reads my name again', async () => {
    // Given a first refresh whose read failed
    const { liteUsername, readLiteUsername } = createRefresh({
      read: () => Promise.reject(new Error('people unavailable')),
    });
    await liteUsername.refresh(buildWallet(undefined), readReportedAccount());
    readLiteUsername.mockResolvedValueOnce('alice.42');

    // When the next core refreshes
    const name = await liteUsername.refresh(buildWallet(undefined), readReportedAccount());

    // Then the network is read again and the name comes back
    expect(name).toBe('alice.42');
    expect(readLiteUsername).toHaveBeenCalledTimes(2);
  });

  it('As a user on a page with several cores, I refresh my name from each and the network is read once', async () => {
    // Given a network that holds my name
    const { liteUsername, readLiteUsername } = createRefresh({ read: () => Promise.resolve('alice.42') });

    // When two cores refresh at once and a third after them
    await Promise.all([
      liteUsername.refresh(buildWallet(undefined), readReportedAccount()),
      liteUsername.refresh(buildWallet(undefined), readReportedAccount()),
    ]);
    await liteUsername.refresh(buildWallet(undefined), readReportedAccount());

    // Then the network was read once
    expect(readLiteUsername).toHaveBeenCalledTimes(1);
  });

  it('As a user on a page with several cores whose name could not be saved, I see it reported once and still use the new name', async () => {
    // Given a save that fails once
    const { liteUsername, saveIdentity, reportFailure } = createRefresh({ read: () => Promise.resolve('alice.42') });
    saveIdentity.mockRejectedValueOnce(new Error('frame gone'));

    // When two cores refresh at once
    const names = await Promise.all([
      liteUsername.refresh(buildWallet(undefined), readReportedAccount()),
      liteUsername.refresh(buildWallet(undefined), readReportedAccount()),
    ]);

    // Then both get the new name and the failed save is reported once
    expect(names).toEqual(['alice.42', 'alice.42']);
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledWith(expect.any(Error), 'identity-save');
  });

  it('As a user whose first core went down before it reported my account, I boot the next core and it still gets my name', async () => {
    // Given: a core that never reports its account
    const { liteUsername } = createRefresh({ read: () => Promise.resolve('alice.42') });
    void liteUsername.refresh(buildWallet(undefined), new Promise<string>(() => undefined));

    // When the next core refreshes
    const name = await liteUsername.refresh(buildWallet(undefined), readReportedAccount());

    // Then it gets the name
    expect(name).toBe('alice.42');
  });

  it('As an operator, I see a network read of the name that fails recorded and counted', async () => {
    // Given a network read that fails
    const { captures, counted } = bindReports();
    const { liteUsername } = createRefresh({ read: () => Promise.reject(new Error('people unavailable')) });

    // When the name is refreshed
    await liteUsername.refresh(buildWallet('alice.42'), readReportedAccount());

    // Then the failure is recorded as expected and counted
    expect(captures.expected).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'people unavailable' }),
      expect.objectContaining({
        step: 'lite_username_read',
      }),
    );
    expect(counted('wallet.local_activate')).toEqual([{ outcome: 'error', reason: 'username-read' }]);
  });
});
