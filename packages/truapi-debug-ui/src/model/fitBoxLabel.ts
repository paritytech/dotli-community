// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BOX_LABEL_CHAR_WIDTH, BOX_LABEL_INSET } from './timelineGeometry.js';

/**
 * `label` cut with an ellipsis to fit a timeline box `width` px wide, or an empty string when not even one character
 * and the ellipsis fit. Never throws.
 */
export function fitBoxLabel(label: string, width: number): string {
  const room = Math.floor((width - 2 * BOX_LABEL_INSET) / BOX_LABEL_CHAR_WIDTH);
  if (label.length <= room) {
    return label;
  }
  return room < 2 ? '' : `${label.slice(0, room - 1)}…`;
}
