// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { clampTo } from './clampTo.js';
import { getSplitBounds } from './getSplitBounds.js';

/** The first pane's size for a pointer `offset` px into a body `span` px long, leaving both panes their minimum. */
export function clampSplit(offset: number, span: number): number {
  return clampTo(offset, getSplitBounds(span));
}
