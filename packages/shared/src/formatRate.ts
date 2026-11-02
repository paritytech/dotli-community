// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { formatSize } from './formatSize.js';

/** A transfer rate, so a trickle reads in bytes rather than as "0 kB/s". */
export function formatRate(bytesPerSecond: number): string {
  return `${formatSize(bytesPerSecond)}/s`;
}
