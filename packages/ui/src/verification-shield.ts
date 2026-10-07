// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** "verified" means the visitor's light client checked it, "trusted" means an RPC provider did. */
export type ShieldState = 'verified' | 'trusted';

export const VERIFICATION_SHIELD_ID = 'verification-shield';
export const VERIFICATION_TOOLTIP_ID = 'verification-tooltip';
