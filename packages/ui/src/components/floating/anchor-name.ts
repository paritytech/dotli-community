// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Its own module so the eager Popover and DropdownMenu shells don't pull in FloatingLayer. */
export function anchorName(id: string): string {
  return `--anchor-${id}`;
}
