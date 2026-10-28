// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** How the window shows the product account a third-party site names. */

import type { ProductAccountId } from '@parity/truapi';

/** An account as the window shows it: the product name and the index as the site wrote them. */
export type DisplayAccount = {
  product: string;
  index: string;
};

/** The product and index of `account` as a site writes them. */
export function toDisplayAccount(account: ProductAccountId): DisplayAccount {
  return { product: account.dotNsIdentifier, index: getDisplayIndex(account.derivationIndex) };
}

function getDisplayIndex(derivationIndex: ProductAccountId['derivationIndex']): string {
  switch (derivationIndex.tag) {
    case 'Index':
      return String(derivationIndex.value);
    case 'Raw':
      return derivationIndex.value;
  }
}
