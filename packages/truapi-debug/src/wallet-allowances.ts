// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The Wallet tab's read-only allowance snapshot of the local wallet, and its text. On-chain integers stay exact
// decimal strings: they are never rounded through Number, and token decimals are never guessed.

/** The finalized block one section was read at. Sections on different chains are not one atomic moment. */
export interface AllowanceObservation {
  genesisHash: string;
  blockHash: string;
  blockNumber: number;
  specVersion: number;
  /** `Timestamp.Now` of the block, in Unix seconds, never the browser clock. */
  chainTimestamp: number;
}

/** A section that could not be read is unknown, never zero. */
export type AllowanceResult<T> =
  { status: 'available'; observation: AllowanceObservation; value: T } | { status: 'unavailable'; reason: string };

/** Total PGAS balance of the product's default account, Index(0). Not a spendability promise. */
export interface PgasBalanceSnapshot {
  /** `Pgas.PgasAssetId`, a decimal integer. */
  assetId: string;
  /** Null when the asset has no `Assets.Metadata`; the balance is then in base units only. */
  decimals: number | null;
  symbol: string | null;
  accountId: string;
  derivationIndex: 0;
  /** Exact decimal base units. */
  balance: string;
}

/** `TransactionStorage.Authorizations` of the product's dedicated Bulletin storage account. */
export type BulletinQuota =
  | { accountId: string; status: 'missing' }
  | {
      accountId: string;
      /** Expired once the Bulletin block reaches `expiresAtBlock`; what remains is then unusable. */
      status: 'active' | 'expired';
      /** Charged-byte counter; it can exceed the allowance. */
      bytesUsed: string;
      bytesLimit: string;
      bytesRemaining: string;
      transactionsUsed: number;
      transactionsLimit: number;
      transactionsRemaining: number;
      expiresAtBlock: number;
    };

export interface WalletAllowanceSnapshot {
  identityAccountId: string;
  networkSuffix: string;
  productId: string;
  pgasBalance: AllowanceResult<PgasBalanceSnapshot>;
  bulletinQuota: AllowanceResult<BulletinQuota>;
}

/** A non-negative integer with digit grouping, or `Unavailable`. */
export function formatInteger(value: string | number): string {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : 'Unavailable';
  }
  return /^\d+$/.test(value) ? BigInt(value).toLocaleString('en-US') : 'Unavailable';
}

/** Unix seconds as `YYYY-MM-DD HH:MM:SS UTC`. */
export function formatChainTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime())
    ? date.toISOString().replace('T', ' ').replace('.000Z', ' UTC')
    : 'Unavailable';
}

/** Whole and fractional token units when the decimals are known, always with the exact base units. */
export function formatTokenBalance(balance: string, decimals: number | null, symbol: string | null): string {
  const base = formatInteger(balance);
  if (base === 'Unavailable') {
    return base;
  }
  if (decimals === null) {
    return `${base} base units (token decimals unavailable)`;
  }
  if (decimals === 0) {
    return `${base} ${symbol ?? 'tokens'}`;
  }
  const digits = BigInt(balance)
    .toString()
    .padStart(decimals + 1, '0');
  const units = `${formatInteger(digits.slice(0, -decimals))}.${digits.slice(-decimals)}`;
  return `${units} ${symbol ?? 'tokens'} (${base} base units; ${String(decimals)} decimals)`;
}

export function formatAuthorization(status: BulletinQuota['status']): string {
  switch (status) {
    case 'active':
      return 'Active at the source block';
    case 'expired':
      return 'Expired — the remaining quota is not usable';
    case 'missing':
      return 'Not found — no storage authorization';
  }
}
