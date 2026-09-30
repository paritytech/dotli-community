// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The URL pill shield's words and glyphs, shared by the shield
// (VerificationShield) and its explainer (VerificationContent).

import type { ShieldState } from '../../verification-shield.js';

export const TOOLTIP_TITLE = 'How was this site loaded?';

const SHIELD_OUTLINE = 'M12 2L3 7v5c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-9-5z';

// Material "gpp_good" / "gpp_maybe" vocabulary: a check for verified, an
// exclamation mark for "protected, but take note". Both cut out of one fill.
export const GLYPH_PATHS: Record<ShieldState, string> = {
  verified: `${SHIELD_OUTLINE}m-1 14.59l-3.29-3.3 1.41-1.41L11 13.76l4.88-4.88 1.41 1.41L11 16.59z`,
  trusted: `${SHIELD_OUTLINE}M11 7.5h2v6h-2zM11 15.5h2v2h-2z`,
};
