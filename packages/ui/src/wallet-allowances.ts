// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The Wallet tab's read-only allowance snapshot of the local wallet: the page product's PGAS balance on Asset Hub
// and its Bulletin storage authorization, each read at one finalized block of its chain. Nothing is claimed, signed
// or written. Statement-store slots and the PGAS and Bulletin claim pools are not read: their storage keys are
// Bandersnatch ring-VRF aliases, which only the core's wasm derives.

import { getActiveServicesConfig } from '@dotli/config';
import { toHex } from '@dotli/shared';
import type {
  AllowanceObservation,
  AllowanceResult,
  BulletinQuota,
  PgasBalanceSnapshot,
  WalletAllowanceSnapshot,
} from '@dotli/truapi-debug';
import type * as Papi from 'polkadot-api';
import type { ChainDefinition, PolkadotClient, TypedApi } from 'polkadot-api';
import { loadBridge, type BridgeModule } from './lazy.js';
import { deriveHardPath, identityKeypair, productAccountKeypair } from './local-wallet-keys.js';
import type { LocalWalletBoot } from './wallet-boot.js';

type UnsafeApi = TypedApi<ChainDefinition, false>;

interface ChainAccess {
  papi: typeof Papi;
  hostChainProvider: BridgeModule['hostChainProvider'];
}

interface FinalizedBlock {
  papi: typeof Papi;
  client: PolkadotClient;
  api: UnsafeApi;
  at: { at: string };
  number: number;
}

const U32_MAX = 0xffff_ffff;

function storage(api: UnsafeApi, pallet: string, item: string) {
  const entry = api.query[pallet]?.[item];
  if (entry === undefined) {
    throw new Error(`The runtime does not expose ${pallet}.${item}`);
  }
  return entry;
}

function constant(api: UnsafeApi, pallet: string, name: string) {
  const entry = api.constants[pallet]?.[name];
  if (entry === undefined) {
    throw new Error(`The runtime does not expose ${pallet}.${name}`);
  }
  return entry;
}

function field(value: unknown, name: string, what: string): unknown {
  if (typeof value !== 'object' || value === null || !(name in value)) {
    throw new Error(`${what} has no ${name}`);
  }
  return (value as Record<string, unknown>)[name];
}

function u32(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new Error(`${what} is not a u32`);
  }
  return value;
}

function unsigned(value: unknown, what: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new Error(`${what} is not an unsigned integer`);
  }
  return value;
}

/** Reads `read` at the chain's finalized block, kept pinned until it is done. Any failure leaves it unknown. */
async function readFinalized<T>(
  { papi, hostChainProvider }: ChainAccess,
  genesisHash: string,
  chain: string,
  read: (block: FinalizedBlock) => Promise<T>,
): Promise<AllowanceResult<T>> {
  try {
    const provider = hostChainProvider(genesisHash);
    if (provider === null) {
      return { status: 'unavailable', reason: `${chain} is not reachable on this chain backend` };
    }
    const client = papi.createClient(provider);
    try {
      const block = await client.getFinalizedBlock();
      const release = client.hodlBlock(block.hash);
      try {
        const api = client.getUnsafeApi();
        const at = { at: block.hash };
        const [now, version] = await Promise.all([
          storage(api, 'Timestamp', 'Now').getValue(at),
          constant(api, 'System', 'Version')(at),
        ]);
        // `Timestamp.Now` defaults to zero, which no produced block has.
        const millis = unsigned(now, 'Timestamp.Now');
        if (millis === 0n) {
          throw new Error('Timestamp.Now is absent at the finalized block');
        }
        const observation: AllowanceObservation = {
          genesisHash,
          blockHash: block.hash,
          blockNumber: block.number,
          specVersion: u32(field(version, 'spec_version', 'System.Version'), 'System.Version spec_version'),
          chainTimestamp: Number(millis / 1000n),
        };
        return { status: 'available', observation, value: await read({ papi, client, api, at, number: block.number }) };
      } finally {
        release();
      }
    } finally {
      client.destroy();
    }
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

function symbolText(symbol: unknown): string | null {
  if (!(symbol instanceof Uint8Array) || symbol.length === 0) {
    return null;
  }
  // A symbol that is not UTF-8 is shown as unknown, never guessed.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(symbol);
  } catch {
    return null;
  }
}

async function readPgasBalance(block: FinalizedBlock, account: Uint8Array): Promise<PgasBalanceSnapshot> {
  const { papi, client, api, at } = block;
  const assetId = u32(await constant(api, 'Pgas', 'PgasAssetId')(at), 'Pgas.PgasAssetId');
  const metadata = storage(api, 'Assets', 'Metadata');
  // `Assets.Metadata` defaults to zero decimals, so only a stored entry tells the token's decimals.
  const stored = await client.rawQuery(await metadata.getKey(assetId), at);
  const value: unknown = stored === null ? null : await metadata.getValue(assetId, at);
  const holding: unknown = await storage(api, 'Assets', 'Account').getValue(assetId, papi.AccountId().dec(account), at);
  return {
    assetId: String(assetId),
    decimals: value === null ? null : u32(field(value, 'decimals', 'Assets.Metadata'), 'Assets.Metadata decimals'),
    symbol: value === null ? null : symbolText(field(value, 'symbol', 'Assets.Metadata')),
    accountId: toHex(account),
    derivationIndex: 0,
    // An account the asset has no entry for holds none of it.
    balance:
      holding === undefined
        ? '0'
        : unsigned(field(holding, 'balance', 'Assets.Account'), 'Assets.Account balance').toString(),
  };
}

async function readBulletinQuota(block: FinalizedBlock, account: Uint8Array): Promise<BulletinQuota> {
  const { papi, api, at } = block;
  const accountId = toHex(account);
  const value: unknown = await storage(api, 'TransactionStorage', 'Authorizations').getValue(
    { type: 'Account', value: papi.AccountId().dec(account) },
    at,
  );
  if (value === undefined) {
    return { accountId, status: 'missing' };
  }
  const extent = field(value, 'extent', 'TransactionStorage.Authorizations');
  const what = 'TransactionStorage.Authorizations extent';
  const transactionsUsed = u32(field(extent, 'transactions', what), `${what} transactions`);
  const transactionsLimit = u32(field(extent, 'transactions_allowance', what), `${what} transactions_allowance`);
  const bytesUsed = unsigned(field(extent, 'bytes', what), `${what} bytes`);
  const bytesLimit = unsigned(field(extent, 'bytes_allowance', what), `${what} bytes_allowance`);
  const expiresAtBlock = u32(
    field(value, 'expiration', 'TransactionStorage.Authorizations'),
    'TransactionStorage.Authorizations expiration',
  );
  // The counters are soft, so usage can exceed the allowance; what remains saturates at zero.
  return {
    accountId,
    status: block.number >= expiresAtBlock ? 'expired' : 'active',
    bytesUsed: bytesUsed.toString(),
    bytesLimit: bytesLimit.toString(),
    bytesRemaining: (bytesLimit > bytesUsed ? bytesLimit - bytesUsed : 0n).toString(),
    transactionsUsed,
    transactionsLimit,
    transactionsRemaining: Math.max(0, transactionsLimit - transactionsUsed),
    expiresAtBlock,
  };
}

/**
 * Reads the page product's default PGAS account, Index(0), and its separate Bulletin storage account. Null on the
 * landing page, which has no product to inspect. Rejects when the connected identity is not `wallet`'s, rather than
 * describing another wallet's accounts.
 */
export async function readWalletAllowances(
  wallet: LocalWalletBoot,
  identityAccountId: string,
): Promise<WalletAllowanceSnapshot | null> {
  const config = getActiveServicesConfig();
  const networkSuffix = config.dotns.TLD;
  if (toHex(identityKeypair(wallet.entropy, networkSuffix).publicKey) !== identityAccountId.toLowerCase()) {
    throw new Error('The connected identity is not this page’s local wallet. Reload the page.');
  }
  // Loaded with the read, as the identity reader does, so neither the bridge nor `polkadot-api` joins the panel's
  // chunk.
  const [{ hostChainProvider, pageProductId }, papi] = await Promise.all([loadBridge(), import('polkadot-api')]);
  const productId = pageProductId();
  if (productId === null) {
    return null;
  }
  const productAccount = productAccountKeypair(wallet.entropy, productId, 0).publicKey;
  const storageAccount = deriveHardPath(wallet.entropy, ['allowance', 'bulletin', productId]).publicKey;
  const access = { papi, hostChainProvider };
  const [pgasBalance, bulletinQuota] = await Promise.all([
    readFinalized(access, config.assethub.genesis, 'Asset Hub', block => readPgasBalance(block, productAccount)),
    readFinalized(access, config.bulletin.genesis, 'Bulletin', block => readBulletinQuota(block, storageAccount)),
  ]);
  return { identityAccountId, networkSuffix, productId, pgasBalance, bulletinQuota };
}
