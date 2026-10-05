// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The board's settings sliders as one 24 px path. The topbar's Settings
 * button (components/shell/SettingsPopover.tsx) draws it, and so does a
 * button that sends the visitor there, so both carry the same mark.
 */
export const SLIDERS_PATH = 'M20 7h-9 M14 17H4 M4 7a3 3 0 1 0 6 0a3 3 0 1 0-6 0 M14 17a3 3 0 1 0 6 0a3 3 0 1 0-6 0';

/** The sliders as markup for a button's leading icon, at 15px so it sits with the button text. */
export const SETTINGS_GLYPH = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="${SLIDERS_PATH}"/></svg>`;
