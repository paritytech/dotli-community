// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { formatRate, formatSize } from '@dotli/shared';
import type { TransferView } from './chains.js';

/** A row of the transfer footer. */
export type TransferRow = { label: string; value: string };

/**
 * The transfer footer while the product loads: its speed, and its size or how much of it came. Once the product is on
 * screen speed and size describe history, so both are null. A size shows only with a known, positive total.
 */
export function describeTransfer(
  transfer: TransferView,
  loading: boolean,
): { speed: TransferRow | null; size: TransferRow | null } {
  if (!loading) {
    return { speed: null, size: null };
  }
  const { bytesPerSecond, fetched, total } = transfer;
  const speed = bytesPerSecond === null ? null : { label: 'Speed', value: formatRate(bytesPerSecond) };
  if (fetched === null || total === null || total <= 0) {
    return { speed, size: null };
  }
  const size =
    fetched >= total
      ? { label: 'Size', value: formatSize(total) }
      : { label: 'Downloading', value: `${formatSize(fetched)} / ${formatSize(total)}` };
  return { speed, size };
}
