// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Messages that leave the shell. A product may branch on the text, so rewording one is a breaking change.

export const ERRORS = {
  PREIMAGE_SUBMIT_DENIED: 'User denied preimage submit',
  DECRYPTION_CANCELLED: 'User cancelled decryption',
  /** @deprecated Nothing produces this. Kept because a product may still match on the text. */
  ALIAS_PERMISSION_DENIED: 'User denied alias permission',
  /** @deprecated Nothing produces this. Kept because a product may still match on the text. */
  ALIAS_PERMISSION_DISMISSED: 'User dismissed alias permission dialog',
  IDENTITY_DISCLOSURE_DISMISSED: 'User dismissed identity disclosure dialog',
  PERMISSION_DIALOG_DISMISSED: 'User dismissed permission dialog',
  PERMISSION_PROMPT_RATE_LIMITED: 'Permission prompt rate limited',
  SCHEDULE_LIMIT_REACHED: 'ScheduleLimitReached',
  STORAGE_READ_FAILED: 'Failed to read from storage',
  STORAGE_WRITE_FAILED: 'Failed to write to storage',
  STORAGE_CLEAR_FAILED: 'Failed to clear storage',
  CHAIN_PROVIDER_UNAVAILABLE: 'Chain provider unavailable',
  INVALID_JSON_RPC_REQUEST: 'Invalid JSON-RPC request',
  CROSS_ORIGIN_APP_URL: 'Refusing to render an app URL outside its sandbox origin',
  MISSING_MODAL_COORDINATOR: 'Top bar initialized without a blocking modal coordinator',
} as const;
