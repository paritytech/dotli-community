// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalletAllowanceSnapshot } from '@dotli/truapi-debug';

const reader = vi.hoisted(() => ({
  readWalletAllowances: vi.fn<() => Promise<WalletAllowanceSnapshot | null>>(),
}));
vi.mock('../../src/wallet-allowances.js', () => reader);

import { AllowanceSection } from '../../src/components/truapi-debug/wallet/AllowanceSnapshot.js';
import type { LocalWalletBoot } from '../../src/wallet-boot.js';
import { renderComponent, resetStores, settle } from '../helpers/solid.js';
import { byTestId } from '../support.js';

const IDENTITY = `0x${'11'.repeat(32)}`;
const WALLET: LocalWalletBoot = { status: 'ok', entropy: new Uint8Array(16), identity: null };
const OBSERVATION = {
  genesisHash: '0x01',
  blockHash: '0xaa',
  blockNumber: 1_686_147,
  specVersion: 3_003_000,
  chainTimestamp: 1_791_758_364,
};

function snapshot(balance: string): WalletAllowanceSnapshot {
  return {
    identityAccountId: IDENTITY,
    networkSuffix: 'paseo',
    productId: 'chat.paseo',
    pgasBalance: {
      status: 'available',
      observation: OBSERVATION,
      value: {
        assetId: '2000000000',
        decimals: null,
        symbol: null,
        accountId: `0x${'22'.repeat(32)}`,
        derivationIndex: 0,
        balance,
      },
    },
    bulletinQuota: {
      status: 'available',
      observation: { ...OBSERVATION, blockNumber: 2_000 },
      value: {
        accountId: `0x${'33'.repeat(32)}`,
        status: 'active',
        bytesUsed: '4096',
        bytesLimit: '1048576',
        bytesRemaining: '1044480',
        transactionsUsed: 3,
        transactionsLimit: 10,
        transactionsRemaining: 7,
        expiresAtBlock: 459_314,
      },
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

function render(): void {
  renderComponent(() => <AllowanceSection wallet={WALLET} identityAccountId={IDENTITY} />);
}

function refresh(): HTMLButtonElement {
  return byTestId('td-wallet-allowances-refresh', document, HTMLButtonElement);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  resetStores();
});

describe('AllowanceSection', () => {
  it("As a local wallet user on a product, I see its PGAS balance and Bulletin quota at the chains' finalized blocks", async () => {
    // Given
    const read = deferred<WalletAllowanceSnapshot | null>();
    reader.readWalletAllowances.mockReturnValueOnce(read.promise);
    render();
    await settle();
    expect(byTestId('td-wallet-allowances-loading').textContent).toBe('Reading finalized chain state…');

    // When
    read.resolve(snapshot('12345'));
    await settle();

    // Then
    expect(reader.readWalletAllowances).toHaveBeenCalledWith(WALLET, IDENTITY);
    byTestId('td-wallet-allowance-snapshot');
    expect(byTestId('td-wallet-allowance-pgas-balance').textContent).toBe(
      '12,345 base units (token decimals unavailable)',
    );
    expect(byTestId('td-wallet-allowance-bulletin-status').textContent).toBe('Active at the source block');
    expect(byTestId('td-wallet-allowance-bulletin-bytes').textContent).toBe(
      '4,096 used / 1,048,576 limit · 1,044,480 remaining',
    );
    expect(byTestId('td-wallet-allowance-pgas').textContent).toContain(
      'Asset Hub · finalized block 1,686,147 · 2026-10-11 22:39:24 UTC',
    );
  });

  it('As a local wallet user whose Bulletin chain could not be read, I see why and still see my PGAS balance', async () => {
    // Given
    reader.readWalletAllowances.mockResolvedValueOnce({
      ...snapshot('7'),
      bulletinQuota: { status: 'unavailable', reason: 'Bulletin is not reachable on this chain backend' },
    });

    // When
    render();
    await settle();

    // Then
    expect(byTestId('td-wallet-allowance-bulletin-unavailable').textContent).toBe(
      'Unavailable: Bulletin is not reachable on this chain backend',
    );
    expect(byTestId('td-wallet-allowance-pgas-balance').textContent).toBe('7 base units (token decimals unavailable)');
  });

  it('As a local wallet user, Refresh reads again and only the latest read is shown', async () => {
    // Given
    reader.readWalletAllowances.mockResolvedValueOnce(snapshot('1'));
    render();
    await settle();
    const slow = deferred<WalletAllowanceSnapshot | null>();
    const fast = deferred<WalletAllowanceSnapshot | null>();
    reader.readWalletAllowances.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);

    // When
    refresh().click();
    await settle();
    refresh().click();
    await settle();
    fast.resolve(snapshot('3'));
    await settle();
    slow.resolve(snapshot('2'));
    await settle();

    // Then
    expect(reader.readWalletAllowances).toHaveBeenCalledTimes(3);
    expect(byTestId('td-wallet-allowance-pgas-balance').textContent).toBe('3 base units (token decimals unavailable)');
  });

  it('As a local wallet user whose read failed, I am told why and can try again', async () => {
    // Given
    reader.readWalletAllowances.mockRejectedValueOnce(
      new Error('The connected identity is not this page’s local wallet. Reload the page.'),
    );
    render();
    await settle();
    expect(byTestId('td-wallet-allowances-error').textContent).toBe(
      'The connected identity is not this page’s local wallet. Reload the page.',
    );

    // When
    reader.readWalletAllowances.mockResolvedValueOnce(snapshot('5'));
    refresh().click();
    await settle();

    // Then
    expect(byTestId('td-wallet-allowance-pgas-balance').textContent).toBe('5 base units (token decimals unavailable)');
  });

  it('As a local wallet user on the landing page, I am told there is no product to inspect', async () => {
    // Given
    reader.readWalletAllowances.mockResolvedValueOnce(null);

    // When
    render();
    await settle();

    // Then
    expect(byTestId('td-wallet-allowances-no-product').textContent).toContain('No product is open on this page.');
    expect(refresh().hidden).toBe(true);
    expect(document.querySelector('[data-testid="td-wallet-allowance-snapshot"]')).toBeNull();
  });
});
