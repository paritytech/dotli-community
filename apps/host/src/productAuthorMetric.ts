// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineCount } from '@dotli/metrics';

/**
 * Count. A read behind the product card's author failed, so the card shows less of the author. Expected. Tagged
 * `outcome` (error) and `reason`, the read that failed: `owner` (counted while the product resolves), `cached-owner`
 * (a cached owner that is no address, counted when the cached copy is read), and `account` or `username` (counted
 * when the card opens).
 */
export const productAuthorMetric = defineCount<'error'>('product.author');
