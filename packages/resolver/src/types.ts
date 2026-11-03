// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** How far a name read has come. */
export type ResolvePhase = 'asset-hub-connecting' | 'asset-hub-syncing' | 'asset-hub-ready' | 'resolving-content';

/**
 * Hears each phase a name read reaches. A resolve started inside a store's listener round can hear the latest phase
 * twice and miss an earlier one.
 */
export type PhaseCallback = (phase: ResolvePhase) => void;
