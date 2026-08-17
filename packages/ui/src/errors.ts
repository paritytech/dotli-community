// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the shell says when a request from a product cannot be granted.
//
// Every message here leaves the shell. Some reach the visitor, the rest reach
// the product's own error handler, which is why the wording is pinned in one
// place: a product may branch on the text, so a reworded message is a breaking
// change rather than a copy edit.

export const UI_ERRORS = {
  PREIMAGE_SUBMIT_DENIED: "User denied preimage submit",
  DECRYPTION_CANCELLED: "User cancelled decryption",
  ALIAS_PERMISSION_DENIED: "User denied alias permission",
  ALIAS_PERMISSION_DISMISSED: "User dismissed alias permission dialog",
  IDENTITY_DISCLOSURE_DISMISSED: "User dismissed identity disclosure dialog",
  PERMISSION_DIALOG_DISMISSED: "User dismissed permission dialog",
  PERMISSION_PROMPT_RATE_LIMITED: "Permission prompt rate limited",
  NOTIFICATIONS_PERMISSION_DENIED: "Notifications permission denied",
  SCHEDULE_LIMIT_REACHED: "ScheduleLimitReached",
  STORAGE_READ_FAILED: "Failed to read from storage",
  STORAGE_WRITE_FAILED: "Failed to write to storage",
  STORAGE_CLEAR_FAILED: "Failed to clear storage",
  CHAIN_PROVIDER_UNAVAILABLE: "Chain provider unavailable",
  INVALID_JSON_RPC_REQUEST: "Invalid JSON-RPC request",
  CROSS_ORIGIN_APP_URL:
    "Refusing to render an app URL outside its sandbox origin",
  MISSING_MODAL_COORDINATOR:
    "Top bar initialized without a blocking modal coordinator",
} as const;
