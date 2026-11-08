// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineCount } from '@dotli/metrics';

/**
 * A sandbox run whose load rejected or whose failure could not be shown, both outside the load's own handling. Tagged
 * `outcome` and `reason` (`load_rejected`, `show_threw`, `fallback_missing` or `top_level`). `top_level` is a top-level
 * load of the sandbox, which is expected.
 */
export const appRunMetric = defineCount<'error'>('app.run');
