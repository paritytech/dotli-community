// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** How far a name read has come. */
export type ResolvePhase = 'asset-hub-connecting' | 'asset-hub-syncing' | 'asset-hub-ready' | 'resolving-content';

/** Hears each phase a name read reaches. */
export type PhaseCallback = (phase: ResolvePhase) => void;
