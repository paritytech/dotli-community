// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineCount } from '@dotli/metrics';

/**
 * Count. A held chain whose teardown threw as the pool closed it, whose pause or resume threw, or whose empty extra
 * lane threw as it closed, told apart by the `step` tag (`chain_pool_close`, `chain_pool_pause`, `chain_pool_resume`,
 * `chain_lane_close`). Tagged `outcome` (error) and `reason` (the error's name).
 */
export const chainPoolCloseMetric = defineCount<'error'>('chain_pool.close');
