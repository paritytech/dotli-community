// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineCount } from '@dotli/metrics';

/**
 * A sandbox run that failed outside the load's own handling, or that the visitor or the browser cut short. Tagged
 * `outcome` and `reason` (`load_rejected`, `show_threw`, `fallback_missing`, `top_level` or `decrypt_cancelled`). The
 * last two are expected: a top-level load of the sandbox, and a visitor who cancelled the password prompt.
 */
export const appRunMetric = defineCount<'error'>('app.run');
