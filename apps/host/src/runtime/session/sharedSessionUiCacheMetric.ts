// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineCount } from '@dotli/metrics';

/**
 * One failed read, write or clear of the cached account shown before the session is read. Tagged `outcome` (error, or
 * invalid for a cache that does not parse) and `reason` (`read`, `write`, `clear` or `json`), as a failure shows a
 * stale name or none.
 */
export const sharedSessionUiCacheMetric = defineCount<'error' | 'invalid'>('shared_session.ui_cache');
