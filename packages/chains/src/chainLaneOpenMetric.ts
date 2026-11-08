// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineCount } from '@dotli/metrics';

/**
 * Count. A chain's lane that could not be built, a consumer's session that could not open on another lane, or the
 * network panel's follow that could not open, told apart by the `step` tag (`chain_lane_build`, `chain_lane_session`,
 * `chain_pool_watch_follow`). Tagged `outcome` (error) and `reason` (the error's name).
 */
export const chainLaneOpenMetric = defineCount<'error'>('chain_pool.lane_open');
