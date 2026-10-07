// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A unique CSS anchor name per trigger, for `trigger-start`. Its own module,
 * so the eager Popover and DropdownMenu shells name their trigger without
 * pulling FloatingLayer into the first visit's chunks.
 */
export function anchorName(id: string): string {
  return `--anchor-${id}`;
}
