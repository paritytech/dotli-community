// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li verification shield: a real button in the URL pill that toggles the
// "How was this site loaded?" explainer, with one glyph per state. It renders
// from components/shell/VerificationShield.tsx, inside the URL pill island;
// its state lives in the url-pill store (state/url-pill.ts).

/** "verified" = the visitor's light client checked it, "trusted" = an RPC provider did. */
export type ShieldState = 'verified' | 'trusted';

export const VERIFICATION_SHIELD_ID = 'verification-shield';
export const VERIFICATION_TOOLTIP_ID = 'verification-tooltip';

export { setVerificationShieldState } from './state/url-pill.js';
