// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_PHRASE, mnemonicToEntropy } from '@polkadot-labs/hdkd-helpers';

const walletSwitch = vi.hoisted(() => ({
  switchToLocalWallet: vi.fn(() => Promise.resolve()),
  switchToPolkadotApp: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/wallet-switch.js', () => walletSwitch);
const walletBoot = vi.hoisted(() => ({
  readWalletBoot: vi.fn(() => Promise.resolve(null)),
  reportLocalWalletFailure: vi.fn(),
}));
vi.mock('../../src/wallet-boot.js', () => walletBoot);
const identity = vi.hoisted(() => ({
  readNetworkLiteUsername: vi.fn(() => Promise.resolve<string | null>(null)),
  adoptLiteUsername: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/local-wallet-identity.js', () => identity);
const username = vi.hoisted(() => ({
  LITE_USERNAME_BASE: /^[a-z]{6,29}$/,
  checkUsernameAvailability: vi.fn(() => Promise.resolve({ status: 'available', digits: [42] })),
  claimLiteUsername: vi.fn(),
}));
vi.mock('../../src/local-wallet-username.js', () => username);
vi.mock('../../src/components/truapi-debug/wallet/AllowanceSnapshot.js', () => ({
  AllowanceSection: (props: { identityAccountId: string }) => (
    <p data-testid="td-wallet-allowances-stub">{props.identityAccountId}</p>
  ),
}));

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

  it('As a new user, I back up a generated phrase before this browser saves the wallet', async () => {
    // Given
    renderComponent(() => <WalletView active />);
    await settle();

    // When
    byTestId('td-wallet-create', document, HTMLButtonElement).click();
    await settle();
    const phrase = byTestId('td-wallet-generated-phrase').textContent;

    // Then: showing the phrase does not save it.
    expect(phrase.split(' ')).toHaveLength(24);
    expect(walletSwitch.switchToLocalWallet).not.toHaveBeenCalled();

    // When
    byTestId('td-wallet-confirm-backup', document, HTMLButtonElement).click();
    await settle();

    // Then
    expect(walletSwitch.switchToLocalWallet).toHaveBeenCalledWith(mnemonicToEntropy(phrase));
  });

  it('As a new user who did not save the generated phrase, I cancel without creating a wallet', async () => {
    // Given
    renderComponent(() => <WalletView active />);
    await settle();
    byTestId('td-wallet-create', document, HTMLButtonElement).click();
    await settle();

    // When
    byTestId('td-wallet-cancel-backup', document, HTMLButtonElement).click();
    await settle();

    // Then
    expect(document.querySelector('[data-testid="td-wallet-generated-phrase"]')).toBeNull();
    expect(byTestId('td-wallet-phrase', document, HTMLTextAreaElement)).not.toBeNull();
    expect(walletSwitch.switchToLocalWallet).not.toHaveBeenCalled();
  });

  it('As a Polkadot App user, I am told what a local wallet is and warned that it is not secure', async () => {
    // When
    renderComponent(() => <WalletView active />);
    await settle();

    // Then
    expect(byTestId('td-wallet-about').textContent).toContain('Copy the recovery phrase from Polkadot App');
    expect(byTestId('td-wallet-warning').textContent).toContain('Use it only for an account you can afford to lose.');
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

  it('As a local wallet user, I see my account and username and forget the wallet to go back to Polkadot App', async () => {
    // Given
    setWalletModeState({ mode: 'local', failure: null });
    setAuthState({
      tag: 'Connected',
      session: { connected: true, identityAccountId: IDENTITY_ACCOUNT, liteUsername: 'alice.42' },
    });
    renderComponent(() => <WalletView active />);
    await settle();

    // When
    byTestId('td-wallet-forget', document, HTMLButtonElement).click();
    await settle();

    // Then
    expect(byTestId('td-wallet-account').textContent).toBe(IDENTITY_ACCOUNT);
    expect(byTestId('td-wallet-username').textContent).toBe('alice.42');
    expect(walletSwitch.switchToPolkadotApp).toHaveBeenCalledTimes(1);
  });

  it('As a local wallet user whose forget failed, I am told to try again', async () => {
    // Given
    walletSwitch.switchToPolkadotApp.mockRejectedValueOnce(new Error('frame gone'));
    setWalletModeState({ mode: 'local', failure: null });
    renderComponent(() => <WalletView active />);
    await settle();

    // When
    byTestId('td-wallet-forget', document, HTMLButtonElement).click();
    await settle();

    // Then
    expect(byTestId('td-wallet-error').textContent).toBe('Could not switch back. Try again.');
    expect(byTestId('td-wallet-error').getAttribute('role')).toBe('alert');
    expect(byTestId('td-wallet-forget', document, HTMLButtonElement).disabled).toBe(false);
  });

  it('As a local wallet user, I replace my wallet with another phrase', async () => {
    // Given
    setWalletModeState({ mode: 'local', failure: null });
    renderComponent(() => <WalletView active />);
    await settle();
    byTestId('td-wallet-replace', document, HTMLButtonElement).click();
    await settle();
    typePhrase(DEV_PHRASE);
    await settle();

    // When
    byTestId('td-wallet-use-local', document, HTMLButtonElement).form?.requestSubmit();
    await settle();

    // Then
    expect(byTestId('td-wallet-use-local').textContent).toBe('Replace');
    expect(walletSwitch.switchToLocalWallet).toHaveBeenCalledWith(mnemonicToEntropy(DEV_PHRASE));
    expect(walletSwitch.switchToPolkadotApp).not.toHaveBeenCalled();
  });

  it('As a local wallet user who changed my mind about replacing, I cancel and keep my wallet', async () => {
    // Given
    setWalletModeState({ mode: 'local', failure: null });
    renderComponent(() => <WalletView active />);
    await settle();
    byTestId('td-wallet-replace', document, HTMLButtonElement).click();
    await settle();

    // When
    byTestId('td-wallet-cancel', document, HTMLButtonElement).click();
    await settle();

    // Then
    expect(document.querySelector('[data-testid="td-wallet-phrase"]')).toBeNull();
    expect(byTestId('td-wallet-account').textContent).toBe('Activating');
    expect(walletSwitch.switchToLocalWallet).not.toHaveBeenCalled();
  });

  it('As a Polkadot App user, the import form has no Cancel', async () => {
    // When
    renderComponent(() => <WalletView active />);
    await settle();

    // Then
    expect(document.querySelector('[data-testid="td-wallet-cancel"]')).toBeNull();
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

  it('As a local wallet user without a username, I see People has none, check a name and see my allowances', async () => {
    // Given
    const boot = { status: 'ok', entropy: new Uint8Array(32), identity: null } as const;
    walletBoot.readWalletBoot.mockResolvedValue(boot as never);
    setWalletModeState({ mode: 'local', failure: null });
    setAuthState({ tag: 'Connected', session: { connected: true, identityAccountId: IDENTITY_ACCOUNT } });
    renderComponent(() => <WalletView active />);
    await settle();
    await settle();

    // When
    const input = byTestId('td-wallet-username-base', document, HTMLInputElement);
    input.value = 'alicex';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    byTestId('td-wallet-username-check', document, HTMLButtonElement).click();
    await settle();
    await settle();

    // Then
    expect(byTestId('td-wallet-username-verified').textContent).toMatch(/^None on /);
    expect(username.checkUsernameAvailability).toHaveBeenCalledWith(boot.entropy, IDENTITY_ACCOUNT, 'alicex');
    expect(byTestId('td-wallet-username-availability').textContent).toBe('Available · e.g. alicex.42');
    expect(byTestId('td-wallet-username-claim', document, HTMLButtonElement).disabled).toBe(false);
    expect(byTestId('td-wallet-allowances-stub').textContent).toBe(IDENTITY_ACCOUNT);
  });
});
