// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type RowSelection = 'selected' | 'paired';

/** How a row reads against the selection: selected itself, in the selected group, or neither. Never throws. */
export function getRowSelection(selected: boolean, inSelectedGroup: boolean): RowSelection | undefined {
  if (selected) {
    return 'selected';
  }
  return inSelectedGroup ? 'paired' : undefined;
}
