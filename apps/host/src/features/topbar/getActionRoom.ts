// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  /** The pill's max width, not finite when the pill sets none. */
  pillMaxWidth: number;
  /** The width of the pill's row. */
  rowWidth: number;
  /** The width of the action group in that row. */
  groupWidth: number;
};

/** Returns the pill's max width less what the rest of its row takes, or undefined when the pill sets no max width. */
export function getActionRoom({ pillMaxWidth, rowWidth, groupWidth }: Params): number | undefined {
  return Number.isFinite(pillMaxWidth) ? pillMaxWidth - (rowWidth - groupWidth) : undefined;
}
