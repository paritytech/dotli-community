// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the app context says when its Service Worker never turns up.
//
// Nothing can be served without a controller, so this failure ends the load
// and names the deadline that expired.

export const SANDBOX_ERRORS = {
  SW_NOT_AVAILABLE: "Service Worker not available after 10s",
} as const;
