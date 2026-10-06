// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Why an anchored surface (Popover, DropdownMenu) closed, which decides
 * whether focus goes back to its trigger. `dismiss` is the sheet's own close
 * (Escape, the scrim, the head's close button, a swipe) for an opening on a
 * phone; the others are FloatingLayer's.
 */
export type CloseReason = 'outside' | 'escape' | 'trigger' | 'blur' | 'focus-out' | 'programmatic' | 'dismiss';
