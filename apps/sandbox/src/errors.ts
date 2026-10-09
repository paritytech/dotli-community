// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Both end the load, since nothing can be served without a Service Worker controller.

export const SANDBOX_ERRORS = {
  SW_NOT_AVAILABLE: 'Service Worker not available after 10s',
  SW_ARCHIVE_NOT_ACKNOWLEDGED: 'Service worker did not acknowledge archive within 10s',
} as const;
