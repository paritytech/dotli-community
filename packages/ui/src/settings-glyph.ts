// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Shared by the Settings button and any button that sends the visitor there, so both carry the same mark. */
export const SLIDERS_PATH = 'M20 7h-9m3 10H4M4 7a3 3 0 1 0 6 0 3 3 0 1 0-6 0m10 10a3 3 0 1 0 6 0 3 3 0 1 0-6 0';

/** At 15px so it sits with the button text. */
export const SETTINGS_GLYPH = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="${SLIDERS_PATH}"/></svg>`;
