// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The ids the name input points at through its ARIA attributes. A plain module, so the input's island loads none of the
// list's code.

/** The suggestion list's element id. */
export const SUGGESTIONS_ID = 'dotli-nav-suggestions';

/** The element id of the suggested option for `label`. */
export function getSuggestionId(label: string): string {
  return `dotli-nav-suggestion-${label}`;
}
