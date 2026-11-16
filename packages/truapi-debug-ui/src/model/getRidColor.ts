// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getHashColor } from './getHashColor.js';

/** A colour per id, light enough to read as text at any hue on the panel's backgrounds, the selected row's included. Never throws. */
export function getRidColor(id: string): string {
  return getHashColor(id, { lightness: 90, chroma: 0.1 });
}
