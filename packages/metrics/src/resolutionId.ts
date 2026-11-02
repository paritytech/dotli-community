// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { m } from './metrics.js';

let resolutionId: string | null = null;

/**
 * Correlate one page load across host, protocol iframe and sandbox, each with its own Sentry trace.
 * Stored even when metrics are off, because the realms that pass it on read it back from here.
 */
export function setResolutionId(id: string): void {
  resolutionId = id;
  m.setDefaults({ resolution_id: id });
}

/** The correlation id of the current page load, or null before the host mints it. */
export function getResolutionId(): string | null {
  return resolutionId;
}
