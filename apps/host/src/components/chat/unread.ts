// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The unread count as a badge shows it, capped so the badge stays small. */
export function chatUnreadLabel(count: number): string {
  return count > 9 ? '9+' : String(count);
}
