// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Each ends the load, since nothing can be served without a Service Worker controller.

import { TIMEOUTS } from '@dotli/config';

export const SANDBOX_ERRORS = {
  SW_NOT_AVAILABLE: `Service Worker not available after ${String(TIMEOUTS.SW_READY / 1000)}s`,
  SW_ARCHIVE_NOT_ACKNOWLEDGED: `Service worker did not acknowledge archive within ${String(TIMEOUTS.SW_ARCHIVE_ACK / 1000)}s`,
  SW_ARCHIVE_NOT_SENT: 'Service worker could not be handed the archive',
} as const;
