// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the sign-in window does to its own page, which its entry, its flow and its island share.

/** Closes the window's own page, which the opener finds closed when its page gets focus or turns visible. */
export function closeWindow(): void {
  window.close();
}
