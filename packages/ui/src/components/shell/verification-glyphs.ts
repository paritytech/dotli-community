// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The URL pill shield's words and glyphs, shared by the shield
// (VerificationShield) and its explainer (VerificationContent).

import type { ShieldState } from '../../verification-shield.js';

export const TOOLTIP_TITLE = 'How was this site loaded?';

const SHIELD_OUTLINE =
  'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z';

// The board's outlined shields, drawn with a stroke: a check for verified, an
// exclamation mark for "protected, but take note".
export const GLYPH_PATHS: Record<ShieldState, readonly string[]> = {
  verified: [SHIELD_OUTLINE, 'm9 12 2 2 4-4'],
  trusted: [SHIELD_OUTLINE, 'M12 8v4', 'M12 16h.01'],
};
