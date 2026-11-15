// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { formatHexHeadAndTail } from './formatHexHeadAndTail.js';
import { formatIdHead } from './formatIdHead.js';

/** A chain id or hash in short: a long `0x` hash by its head and tail, any other value by its head. Never throws. */
export function formatChainValue(value: string): string {
  if (value.startsWith('0x') && value.length > 12) {
    return formatHexHeadAndTail(value);
  }
  return formatIdHead(value);
}
