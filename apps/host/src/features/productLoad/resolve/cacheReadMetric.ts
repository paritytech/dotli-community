// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineCount } from '@dotli/metrics';

/** A cache read. Tag `outcome` (`hit, miss`) and `surface` (`cid_cache, block_cache`). */
export const cacheReadMetric = defineCount<'hit' | 'miss'>('cache.read');
