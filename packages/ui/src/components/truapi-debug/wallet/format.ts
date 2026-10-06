// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Text for the Wallet view's allowance snapshot. On-chain integers are never
// rounded through Number, and token decimals are never guessed.

import type { BulletinQuota } from '@parity/truapi-host/web';

/** Never round on-chain integers through Number or apply guessed token decimals. */
export function integer(value: string | number | undefined): string {
  if (value === undefined) {
    return 'Unavailable';
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : 'Unavailable';
  }
  return /^\d+$/.test(value) ? BigInt(value).toLocaleString('en-US') : 'Unavailable';
}

export function timestamp(seconds: number): string {
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime())
    ? date.toISOString().replace('T', ' ').replace('.000Z', ' UTC')
    : 'Unavailable';
}

export function tokenBalance(balance: string, decimals: number | null, symbol: string | null): string {
  const base = integer(balance);
  if (base === 'Unavailable') {
    return 'Unavailable — invalid balance';
  }
  if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    return `${base} base units (token decimals unavailable)`;
  }
  const digits = BigInt(balance)
    .toString()
    .padStart(decimals + 1, '0');
  const units = decimals === 0 ? integer(digits) : `${integer(digits.slice(0, -decimals))}.${digits.slice(-decimals)}`;
  return `${units} ${symbol ?? 'tokens'} (${base} base units; ${String(decimals)} decimals)`;
}

export function authorization(status: BulletinQuota['status']): string {
  return status === 'active'
    ? 'Active at the source block'
    : status === 'expired'
      ? 'Expired — remaining quota is not usable'
      : status === 'missing'
        ? 'Not found — no storage authorization'
        : 'Unavailable';
}
