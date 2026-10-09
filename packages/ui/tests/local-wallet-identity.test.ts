// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LocalWalletIdentity from '../src/local-wallet-identity.js';

const IDENTITY_ACCOUNT = `0x${'11'.repeat(32)}`;
const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

const mocks = vi.hoisted(() => ({
  updateSharedLocalWalletIdentity: vi.fn(() => Promise.resolve()),
  readLiteUsername: vi.fn(),
}));
vi.mock('@dotli/protocol', () => ({ updateSharedLocalWalletIdentity: mocks.updateSharedLocalWalletIdentity }));
vi.mock('../../metrics/src/metrics.js', () => ({ m: { count: vi.fn() }, getResolutionId: vi.fn(() => null) }));

type Identity = typeof LocalWalletIdentity;

async function load(): Promise<Identity> {
  const identity = await import('../src/local-wallet-identity.js');
  identity.__testing.setReader(mocks.readLiteUsername);
  const { setAuthState } = await import('../src/state/auth.js');
  setAuthState({ tag: 'Connected', session: { connected: true, identityAccountId: IDENTITY_ACCOUNT } });
  return identity;
}

function wallet(liteUsername: string | null | undefined): Parameters<Identity['refreshLiteUsername']>[0] {
  return {
    status: 'ok',
    entropy: ENTROPY,
    identity: liteUsername === undefined ? null : { identityAccountId: IDENTITY_ACCOUNT, liteUsername },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('refreshLiteUsername', () => {
  it('As a user on the first boot after import, I get my name from the network and it is cached', async () => {
    // Given
    mocks.readLiteUsername.mockResolvedValue('alice.42');
    const { refreshLiteUsername } = await load();

    // When
    const name = await refreshLiteUsername(wallet(undefined));

    // Then
    expect(name).toBe('alice.42');
    expect(mocks.updateSharedLocalWalletIdentity).toHaveBeenCalledWith(expect.any(String), {
      identityAccountId: IDENTITY_ACCOUNT,
      liteUsername: 'alice.42',
    });
  });

  it('As a user whose cached name is current, I am not re-activated and nothing is written', async () => {
    // Given
    mocks.readLiteUsername.mockResolvedValue('alice.42');
    const { refreshLiteUsername } = await load();

    // When
    const name = await refreshLiteUsername(wallet('alice.42'));

    // Then
    expect(name).toBeUndefined();
    expect(mocks.updateSharedLocalWalletIdentity).not.toHaveBeenCalled();
  });

  it('As a user without a lite username, I am told so once and keep no name', async () => {
    // Given
    mocks.readLiteUsername.mockResolvedValue(null);
    const { refreshLiteUsername } = await load();

    // When
    const name = await refreshLiteUsername(wallet(undefined));

    // Then
    expect(name).toBeUndefined();
    expect(mocks.updateSharedLocalWalletIdentity).toHaveBeenCalledWith(expect.any(String), {
      identityAccountId: IDENTITY_ACCOUNT,
      liteUsername: null,
    });
  });

  it('As a user whose network read failed, I keep my cached name', async () => {
    // Given
    mocks.readLiteUsername.mockRejectedValue(new Error('people unavailable'));
    const { refreshLiteUsername } = await load();

    // When
    const name = await refreshLiteUsername(wallet('alice.42'));

    // Then
    expect(name).toBeUndefined();
    expect(mocks.updateSharedLocalWalletIdentity).not.toHaveBeenCalled();
  });

  it('As a page with several cores, I read the network once', async () => {
    // Given
    mocks.readLiteUsername.mockResolvedValue('alice.42');
    const { refreshLiteUsername } = await load();

    // When
    await Promise.all([refreshLiteUsername(wallet(undefined)), refreshLiteUsername(wallet(undefined))]);

    // Then
    expect(mocks.readLiteUsername).toHaveBeenCalledTimes(1);
  });
});
