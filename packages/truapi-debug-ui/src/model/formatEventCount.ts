// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { formatCount } from './formatCount.js';

/** `1 event` or `N events`. Never throws. */
export function formatEventCount(count: number): string {
  return formatCount(count, 'event');
}
