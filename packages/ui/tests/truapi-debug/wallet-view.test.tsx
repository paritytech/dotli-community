// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_PHRASE, mnemonicToEntropy } from '@polkadot-labs/hdkd-helpers';

const walletSwitch = vi.hoisted(() => ({
  switchToLocalWallet: vi.fn(() => Promise.resolve()),
  switchToPolkadotApp: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/wallet-switch.js', () => walletSwitch);
vi.mock('../../src/wallet-boot.js', () => ({ reportLocalWalletFailure: vi.fn() }));

import { WalletView } from '../../src/components/truapi-debug/WalletView.js';
import { setAuthState } from '../../src/state/auth.js';
import { setWalletModeState } from '../../src/state/wallet-mode.js';
import { renderComponent, resetStores, settle } from '../helpers/solid.js';
import { byTestId } from '../support.js';

const IDENTITY_ACCOUNT = `0x${'11'.repeat(32)}`;

function typePhrase(phrase: string): void {
  const input = byTestId('td-wallet-phrase', document, HTMLTextAreaElement);
  input.value = phrase;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  resetStores();
});

describe('WalletView', () => {
  it('As a Polkadot App user, I paste my phrase and switch this browser to the local wallet', async () => {
    // Given
    renderComponent(() => <WalletView active />);
    await settle();
    typePhrase(DEV_PHRASE);
    await settle();

    // When
    byTestId('td-wallet-use-local', document, HTMLButtonElement).form?.requestSubmit();
    await settle();

    // Then
    expect(walletSwitch.switchToLocalWallet).toHaveBeenCalledWith(mnemonicToEntropy(DEV_PHRASE));
  });

  it('As a user who mistyped my phrase, I am told and nothing is saved', async () => {
    // Given
    renderComponent(() => <WalletView active />);
    await settle();
    typePhrase('bottom drive obey lake');
    await settle();

    // When
    byTestId('td-wallet-use-local', document, HTMLButtonElement).form?.requestSubmit();
    await settle();

    // Then
    expect(byTestId('td-wallet-error').textContent).toBe('Not a valid recovery phrase');
    expect(walletSwitch.switchToLocalWallet).not.toHaveBeenCalled();
  });

  it('As a local wallet user, I see my account and username and switch back to Polkadot App', async () => {
    // Given
    setWalletModeState({ mode: 'local', failure: null });
    setAuthState({
      tag: 'Connected',
      session: { connected: true, identityAccountId: IDENTITY_ACCOUNT, liteUsername: 'alice.42' },
    });
    renderComponent(() => <WalletView active />);
    await settle();

    // When
    byTestId('td-wallet-use-app', document, HTMLButtonElement).click();
    await settle();

    // Then
    expect(byTestId('td-wallet-account').textContent).toBe(IDENTITY_ACCOUNT);
    expect(byTestId('td-wallet-username').textContent).toBe('alice.42');
    expect(walletSwitch.switchToPolkadotApp).toHaveBeenCalledTimes(1);
  });

  it('As a user whose local wallet could not start, I see why', async () => {
    // Given
    setWalletModeState({ mode: 'app', failure: 'Local wallet could not be decrypted and was forgotten' });

    // When
    renderComponent(() => <WalletView active />);
    await settle();

    // Then
    expect(byTestId('td-wallet-failure').textContent).toBe('Local wallet could not be decrypted and was forgotten');
  });
});
