// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the app context says when its Service Worker never turns up.
//
// Both failures end the load, because nothing can be served without a
// controller, so the wording names the deadline that expired.

export const SANDBOX_ERRORS = {
  SW_NOT_AVAILABLE: "Service Worker not available after 10s",
  SW_ARCHIVE_NOT_ACKNOWLEDGED:
    "Service worker did not acknowledge archive within 10s",
} as const;
