// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createLiteUsernameRefresh } from './local-wallet-identity.js';
import type { LocalWalletBoot } from './wallet-boot.js';

const IDENTITY_ACCOUNT = `0x${'11'.repeat(32)}`;
const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

/** The account a core reported once its local session was active. */
const reported = (): Promise<string> => Promise.resolve(IDENTITY_ACCOUNT);

/** A refresh over a People read that answers with `read`, recording what it saves and reports. */
function refreshWith(read: () => Promise<string | null>) {
  const deps = {
    readLiteUsername: vi.fn(read),
    saveIdentity: vi.fn((): Promise<void> => Promise.resolve()),
    reportFailure: vi.fn(),
  };
  return { ...deps, liteUsername: createLiteUsernameRefresh(deps) };
}

function wallet(liteUsername: string | null | undefined): LocalWalletBoot {
  return {
    entropy: ENTROPY,
    identity: liteUsername === undefined ? null : { identityAccountId: IDENTITY_ACCOUNT, liteUsername },
  };
}

describe('lite username refresh', () => {
  it('As a user on the first boot after import, I get my name from the network and it is cached', async () => {
    // Given
    const { liteUsername, readLiteUsername, saveIdentity } = refreshWith(() => Promise.resolve('alice.42'));

    // When
    const name = await liteUsername.refresh(wallet(undefined), reported());

    // Then
    expect(name).toBe('alice.42');
    expect(readLiteUsername).toHaveBeenCalledWith(IDENTITY_ACCOUNT);
    expect(saveIdentity).toHaveBeenCalledWith({ identityAccountId: IDENTITY_ACCOUNT, liteUsername: 'alice.42' });
  });

  it('As a user whose cached name is current, I am not re-activated and nothing is written', async () => {
    // Given
    const { liteUsername, saveIdentity } = refreshWith(() => Promise.resolve('alice.42'));

    // When
    const name = await liteUsername.refresh(wallet('alice.42'), reported());

    // Then
    expect(name).toBeUndefined();
    expect(saveIdentity).not.toHaveBeenCalled();
  });

  it('As a user without a lite username, I am told so once and keep no name', async () => {
    // Given
    const { liteUsername, saveIdentity } = refreshWith(() => Promise.resolve(null));

    // When
    const name = await liteUsername.refresh(wallet(undefined), reported());

    // Then
    expect(name).toBeUndefined();
    expect(saveIdentity).toHaveBeenCalledWith({ identityAccountId: IDENTITY_ACCOUNT, liteUsername: null });
  });

  it('As a user whose network read failed, I keep my cached name', async () => {
    // Given
    const { liteUsername, saveIdentity } = refreshWith(() => Promise.reject(new Error('people unavailable')));

    // When
    const name = await liteUsername.refresh(wallet('alice.42'), reported());

    // Then
    expect(name).toBeUndefined();
    expect(saveIdentity).not.toHaveBeenCalled();
  });

  it('As a user whose network read failed, the next core on the page reads my name again', async () => {
    // Given
    const { liteUsername, readLiteUsername } = refreshWith(() => Promise.reject(new Error('people unavailable')));
    await liteUsername.refresh(wallet(undefined), reported());
    readLiteUsername.mockResolvedValueOnce('alice.42');

    // When
    const name = await liteUsername.refresh(wallet(undefined), reported());

    // Then
    expect(name).toBe('alice.42');
    expect(readLiteUsername).toHaveBeenCalledTimes(2);
  });

  it('As a page with several cores, I read the network once', async () => {
    // Given
    const { liteUsername, readLiteUsername } = refreshWith(() => Promise.resolve('alice.42'));

    // When
    await Promise.all([
      liteUsername.refresh(wallet(undefined), reported()),
      liteUsername.refresh(wallet(undefined), reported()),
    ]);
    await liteUsername.refresh(wallet(undefined), reported());

    // Then
    expect(readLiteUsername).toHaveBeenCalledTimes(1);
  });

  it('As a page with several cores whose name could not be saved, I report it once and still use the new name', async () => {
    // Given
    const { liteUsername, saveIdentity, reportFailure } = refreshWith(() => Promise.resolve('alice.42'));
    saveIdentity.mockRejectedValueOnce(new Error('frame gone'));

    // When
    const names = await Promise.all([
      liteUsername.refresh(wallet(undefined), reported()),
      liteUsername.refresh(wallet(undefined), reported()),
    ]);

    // Then
    expect(names).toEqual(['alice.42', 'alice.42']);
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledWith(expect.any(Error), 'identity-save');
  });

  it('As a page whose first core went down before it reported my account, the next core still gets my name', async () => {
    // Given: a core that never reports its account
    const { liteUsername } = refreshWith(() => Promise.resolve('alice.42'));
    void liteUsername.refresh(wallet(undefined), new Promise<string>(() => undefined));

    // When
    const name = await liteUsername.refresh(wallet(undefined), reported());

    // Then
    expect(name).toBe('alice.42');
  });

  it('As an operator, a network read of the name that fails is recorded and counted', async () => {
    // Given
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { liteUsername } = refreshWith(() => Promise.reject(new Error('people unavailable')));

    // When
    await liteUsername.refresh(wallet('alice.42'), reported());

    // Then
    expect(captures.expected).toHaveBeenCalledWith(expect.objectContaining({ message: 'people unavailable' }), {
      flow: 'wallet',
      step: 'lite_username_read',
    });
    expect(metrics.counted('wallet.local_activate')).toEqual([{ outcome: 'error', reason: 'username-read' }]);
  });
});
