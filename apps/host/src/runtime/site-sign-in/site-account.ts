// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The product account a third-party site names, read from the `<product>/<index>` the site sends, and how the window
 * shows it. It knows no keys and no message channel.
 */

import { NETWORK_NAME_TO_SERVICES_CONFIG, type Network } from '@dotli/config';
import { isValidDotName } from '@dotli/resolver';
import type { ProductAccountId } from '@parity/truapi';

/** An account as the window shows it: the product name and the index as the site wrote them. */
export interface DisplayAccount {
  product: string;
  index: string;
}

const NUMBER_INDEX = /^(0|[1-9][0-9]{0,9})$/;
const RAW_INDEX = /^0x[0-9a-fA-F]{64}$/;
const MAX_NUMBER_INDEX = 4294967295;

/** Each network's TLD with its leading dot, built once rather than on every parse. */
const TLD_SUFFIX = Object.fromEntries(
  Object.entries(NETWORK_NAME_TO_SERVICES_CONFIG).map(([net, config]) => [net, `.${config.dotns.TLD}`]),
) as Record<Network, string>;

/** The account named by `value`, or null when it is not `<product>/<index>` of `net`'s TLD. */
export function parseSiteAccount(value: unknown, net: Network): ProductAccountId | null {
  if (typeof value !== 'string') {
    return null;
  }
  const parts = value.split('/');
  if (parts.length !== 2) {
    return null;
  }
  const [product, index] = parts as [string, string];
  const suffix = TLD_SUFFIX[net];
  if (!product.endsWith(suffix) || !isValidDotName(product.slice(0, -suffix.length))) {
    return null;
  }
  if (isRawIndex(index)) {
    return { dotNsIdentifier: product, derivationIndex: { tag: 'Raw', value: index } };
  }
  if (NUMBER_INDEX.test(index) && Number(index) <= MAX_NUMBER_INDEX) {
    return { dotNsIdentifier: product, derivationIndex: { tag: 'Index', value: Number(index) } };
  }
  return null;
}

function isRawIndex(value: string): value is `0x${string}` {
  return RAW_INDEX.test(value);
}

/** The product and index of `account` as a site writes them. */
export function displayAccount(account: ProductAccountId): DisplayAccount {
  const { derivationIndex } = account;
  return {
    product: account.dotNsIdentifier,
    index: derivationIndex.tag === 'Index' ? String(derivationIndex.value) : derivationIndex.value,
  };
}
