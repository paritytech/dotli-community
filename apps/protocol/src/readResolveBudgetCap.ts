// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const RESOLVE_BUDGET_KEY = 'dotli:resolve-budget-ms';

/** A tester's cap on each request's sync budget, so a resolver timeout shows in seconds rather than minutes. */
export function readResolveBudgetCap(session: Pick<Storage, 'getItem'> | null): number | undefined {
  const cap = Number(session?.getItem(RESOLVE_BUDGET_KEY) ?? '');
  return Number.isInteger(cap) && cap > 0 ? cap : undefined;
}
