// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The product account a third-party site names, read from the `<product>/<index>` the site sends. It knows no keys and
 * no message channel.
 */

import { NETWORK_NAME_TO_SERVICES_CONFIG, type Network } from '@dotli/config';
import { isValidDotName } from '@dotli/resolver';
import type { ProductAccountId } from '@parity/truapi';

const NUMBER_INDEX = /^(0|[1-9][0-9]{0,9})$/;
const RAW_INDEX = /^0x[0-9a-fA-F]{64}$/;
const MAX_NUMBER_INDEX = 4294967295;

/** The account named by `value`, or null when it is not `<product>/<index>` of `network`'s TLD. */
export function parseSiteAccount(value: unknown, network: Network): ProductAccountId | null {
  if (typeof value !== 'string') {
    return null;
  }
  const [product, index, extra] = value.split('/');
  if (product === undefined || index === undefined || extra !== undefined) {
    return null;
  }
  const suffix = `.${NETWORK_NAME_TO_SERVICES_CONFIG[network].dotns.TLD}`;
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
