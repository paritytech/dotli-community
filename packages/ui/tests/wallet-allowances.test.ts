// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Papi from 'polkadot-api';
import { AccountId } from 'polkadot-api';
import { getActiveServicesConfig } from '@dotli/config';
import { toHex } from '@dotli/shared';
import { deriveHardPath, identityKeypair, productAccountKeypair } from '../src/local-wallet-keys.js';
import type { LocalWalletBoot } from '../src/wallet-boot.js';
import { readWalletAllowances } from '../src/wallet-allowances.js';
import { must } from './support.js';

interface FakeChain {
  hash: string;
  number: number;
  /** `Pallet.Item` to its value for the given keys; a missing item is absent from the runtime. */
  storage: Record<string, (...keys: unknown[]) => unknown>;
  constants: Record<string, unknown>;
  /** Storage keys holding a value, for `rawQuery`. */
  stored?: string[];
}

const mocks = vi.hoisted(() => ({
  chains: new Map<string, FakeChain>(),
  productId: null as string | null,
  calls: [] as { genesis: string; item: string; args: unknown[] }[],
  released: [] as string[],
  destroyed: [] as string[],
}));

vi.mock('../src/lazy.js', () => ({
  loadBridge: () =>
    Promise.resolve({
      hostChainProvider: (genesis: string) => (mocks.chains.has(genesis) ? { genesis } : null),
      pageProductId: () => mocks.productId,
    }),
}));

vi.mock('polkadot-api', async importOriginal => ({
  ...(await importOriginal<typeof Papi>()),
  createClient: ({ genesis }: { genesis: string }) => {
    const chain = mocks.chains.get(genesis);
    if (chain === undefined) {
      throw new Error(`no fake chain ${genesis}`);
    }
    const group = <T>(names: string[], entry: (name: string) => T): Record<string, Record<string, T>> => {
      const pallets: Record<string, Record<string, T>> = {};
      for (const name of names) {
        const [pallet = '', item = ''] = name.split('.');
        pallets[pallet] = { ...pallets[pallet], [item]: entry(name) };
      }
      return pallets;
    };
    const pinned = (options: unknown): void => {
      expect(options).toEqual({ at: chain.hash });
    };
    return {
      getFinalizedBlock: () => Promise.resolve({ hash: chain.hash, number: chain.number, parent: '0x' }),
      hodlBlock: (hash: string) => () => {
        mocks.released.push(hash);
      },
      getUnsafeApi: () => ({
        query: group(Object.keys(chain.storage), item => ({
          getKey: (...keys: unknown[]) => Promise.resolve(`${item}:${JSON.stringify(keys)}`),
          getValue: (...args: unknown[]) => {
            pinned(args.at(-1));
            const keys = args.slice(0, -1);
            mocks.calls.push({ genesis, item, args: keys });
            return Promise.resolve(chain.storage[item]?.(...keys));
          },
        })),
        constants: group(Object.keys(chain.constants), name => (options: unknown) => {
          pinned(options);
          return Promise.resolve(chain.constants[name]);
        }),
      }),
      rawQuery: (key: string, options: unknown) => {
        pinned(options);
        return Promise.resolve(chain.stored?.includes(key) === true ? '0x00' : null);
      },
      destroy: () => {
        mocks.destroyed.push(genesis);
      },
    };
  },
}));

const config = getActiveServicesConfig();
const SUFFIX = config.dotns.TLD;
const PRODUCT = `chat.${SUFFIX}`;
const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const WALLET: LocalWalletBoot = { status: 'ok', entropy: ENTROPY, identity: null };
const IDENTITY = toHex(identityKeypair(ENTROPY, SUFFIX).publicKey);
const PRODUCT_ACCOUNT = productAccountKeypair(ENTROPY, PRODUCT, 0).publicKey;
const STORAGE_ACCOUNT = deriveHardPath(ENTROPY, ['allowance', 'bulletin', PRODUCT]).publicKey;
const PGAS = 2_000_000_000;
const NOW_MS = 1_791_758_364_000n;

function assetHub(overrides: Partial<FakeChain['storage']> = {}, stored = [`Assets.Metadata:[${String(PGAS)}]`]): void {
  mocks.chains.set(config.assethub.genesis, {
    hash: '0xaa',
    number: 1_686_147,
    stored,
    constants: { 'Pgas.PgasAssetId': PGAS, 'System.Version': { spec_name: 'asset-hub', spec_version: 3_003_000 } },
    storage: {
      'Timestamp.Now': () => NOW_MS,
      'Assets.Metadata': () => ({
        deposit: 0n,
        name: new Uint8Array(),
        symbol: new TextEncoder().encode('PGAS'),
        decimals: 10,
        is_frozen: false,
      }),
      'Assets.Account': () => ({ balance: 12_345_000_000_000n, status: { type: 'Liquid' } }),
      ...overrides,
    },
  });
}

function bulletin(authorization: unknown, number = 2_000): void {
  mocks.chains.set(config.bulletin.genesis, {
    hash: '0xbb',
    number,
    constants: { 'System.Version': { spec_version: 1_000_026 } },
    storage: { 'Timestamp.Now': () => NOW_MS + 6_000n, 'TransactionStorage.Authorizations': () => authorization },
  });
}

const ACTIVE = {
  extent: { transactions: 3, transactions_allowance: 10, bytes: 4_096n, extra: 0n, bytes_allowance: 1_048_576n },
  expiration: 459_314,
};

beforeEach(() => {
  mocks.chains.clear();
  mocks.productId = PRODUCT;
  mocks.calls.length = 0;
  mocks.released.length = 0;
  mocks.destroyed.length = 0;
});

describe('readWalletAllowances', () => {
  it("reads the product account's PGAS and its storage account's Bulletin authorization at finalized blocks", async () => {
    assetHub();
    bulletin(ACTIVE);

    const snapshot = must(await readWalletAllowances(WALLET, IDENTITY.toUpperCase().replace('0X', '0x')), 'a snapshot');

    expect(snapshot.productId).toBe(PRODUCT);
    expect(snapshot.networkSuffix).toBe(SUFFIX);
    expect(snapshot.pgasBalance).toEqual({
      status: 'available',
      observation: {
        genesisHash: config.assethub.genesis,
        blockHash: '0xaa',
        blockNumber: 1_686_147,
        specVersion: 3_003_000,
        chainTimestamp: 1_791_758_364,
      },
      value: {
        assetId: '2000000000',
        decimals: 10,
        symbol: 'PGAS',
        accountId: toHex(PRODUCT_ACCOUNT),
        derivationIndex: 0,
        balance: '12345000000000',
      },
    });
    expect(snapshot.bulletinQuota).toEqual({
      status: 'available',
      observation: {
        genesisHash: config.bulletin.genesis,
        blockHash: '0xbb',
        blockNumber: 2_000,
        specVersion: 1_000_026,
        chainTimestamp: 1_791_758_370,
      },
      value: {
        accountId: toHex(STORAGE_ACCOUNT),
        status: 'active',
        bytesUsed: '4096',
        bytesLimit: '1048576',
        bytesRemaining: '1044480',
        transactionsUsed: 3,
        transactionsLimit: 10,
        transactionsRemaining: 7,
        expiresAtBlock: 459_314,
      },
    });
    expect(mocks.calls).toContainEqual({
      genesis: config.assethub.genesis,
      item: 'Assets.Account',
      args: [PGAS, AccountId().dec(PRODUCT_ACCOUNT)],
    });
    expect(mocks.calls).toContainEqual({
      genesis: config.bulletin.genesis,
      item: 'TransactionStorage.Authorizations',
      args: [{ type: 'Account', value: AccountId().dec(STORAGE_ACCOUNT) }],
    });
    expect(mocks.released.sort()).toEqual(['0xaa', '0xbb']);
    expect(mocks.destroyed).toHaveLength(2);
  });

  it('reports an asset without metadata in base units, an account without an entry as zero, and no authorization as missing', async () => {
    assetHub({ 'Assets.Account': () => undefined }, []);
    bulletin(undefined);

    const snapshot = must(await readWalletAllowances(WALLET, IDENTITY), 'a snapshot');

    expect(snapshot.pgasBalance.status === 'available' && snapshot.pgasBalance.value).toMatchObject({
      decimals: null,
      symbol: null,
      balance: '0',
    });
    expect(snapshot.bulletinQuota.status === 'available' && snapshot.bulletinQuota.value).toEqual({
      accountId: toHex(STORAGE_ACCOUNT),
      status: 'missing',
    });
  });

  it('marks an authorization expired at its expiry block and saturates usage over the allowance', async () => {
    assetHub();
    bulletin(
      {
        extent: { transactions: 12, transactions_allowance: 10, bytes: 2_000n, bytes_allowance: 1_000n },
        expiration: 50,
      },
      50,
    );

    const snapshot = must(await readWalletAllowances(WALLET, IDENTITY), 'a snapshot');

    expect(snapshot.bulletinQuota.status === 'available' && snapshot.bulletinQuota.value).toMatchObject({
      status: 'expired',
      bytesUsed: '2000',
      bytesRemaining: '0',
      transactionsUsed: 12,
      transactionsRemaining: 0,
    });
  });

  it('leaves each section unknown on its own when its chain cannot be read', async () => {
    assetHub({ 'Assets.Account': () => ({ balance: 5 }) });

    const snapshot = must(await readWalletAllowances(WALLET, IDENTITY), 'a snapshot');

    expect(snapshot.pgasBalance).toEqual({
      status: 'unavailable',
      reason: 'Assets.Account balance is not an unsigned integer',
    });
    expect(snapshot.bulletinQuota).toEqual({
      status: 'unavailable',
      reason: 'Bulletin is not reachable on this chain backend',
    });
  });

  it('names a storage item the runtime does not expose, and never reads a block without a timestamp', async () => {
    assetHub();
    const chain = mocks.chains.get(config.assethub.genesis);
    if (chain !== undefined) {
      chain.constants = { 'System.Version': { spec_version: 1 } };
    }
    bulletin(ACTIVE);
    const bulletinChain = mocks.chains.get(config.bulletin.genesis);
    if (bulletinChain !== undefined) {
      bulletinChain.storage['Timestamp.Now'] = () => 0n;
    }

    const snapshot = must(await readWalletAllowances(WALLET, IDENTITY), 'a snapshot');

    expect(snapshot.pgasBalance).toEqual({
      status: 'unavailable',
      reason: 'The runtime does not expose Pgas.PgasAssetId',
    });
    expect(snapshot.bulletinQuota).toEqual({
      status: 'unavailable',
      reason: 'Timestamp.Now is absent at the finalized block',
    });
  });

  it('reads nothing on the landing page, which has no product', async () => {
    mocks.productId = null;
    assetHub();
    bulletin(ACTIVE);

    expect(await readWalletAllowances(WALLET, IDENTITY)).toBeNull();
    expect(mocks.calls).toEqual([]);
  });

  it("refuses to describe another wallet's accounts when the connected identity is not this wallet", async () => {
    assetHub();
    bulletin(ACTIVE);

    await expect(readWalletAllowances(WALLET, `0x${'11'.repeat(32)}`)).rejects.toThrow(
      'The connected identity is not this page’s local wallet. Reload the page.',
    );
    expect(mocks.calls).toEqual([]);
  });
});
