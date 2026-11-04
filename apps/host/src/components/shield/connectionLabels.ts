// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ShieldState } from '../../state/urlPillState.js';

// One set of words for a connection, so each place that names one says it the same way.
export const CONNECTION_LABELS: Readonly<Record<ShieldState, string>> = {
  verified: 'Secure connection',
  trusted: 'Trusted connection',
};
