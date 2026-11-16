// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainRole } from '@dotli/config';

/** The names dashboards were built on. The code calls Asset Hub `assethub`. */
export function getChainTelemetryName(role: ChainRole): string {
  return role === 'assethub' ? 'asset-hub' : role;
}
