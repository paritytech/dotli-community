// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createInertMetrics } from './createInertMetrics.js';
import { createLiveMetrics, type Metrics } from './createLiveMetrics.js';

// Read in this module, not shared, so the metrics-off build drops the live API.
const METRICS_ENABLED = import.meta.env.VITE_METRICS === 'true';

/** Sentry spans and metrics. Chosen once per build: every call is a no-op unless VITE_METRICS is "true". */
export const m: Metrics = METRICS_ENABLED ? createLiveMetrics() : createInertMetrics();
