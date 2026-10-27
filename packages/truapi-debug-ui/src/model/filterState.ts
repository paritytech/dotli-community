// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type DirectionFilter = (typeof DIRECTION_FILTERS)[number];

export type FilterState = {
  direction: DirectionFilter;
  /** `undefined` means no product filter. A `null` key matches events with `productId: undefined`. */
  product: string | null | undefined;
  /** Case-insensitive substring, or a regex when wrapped in slashes (`/boot|resolve/`). */
  tagQuery: string;
  /** Same syntax as `tagQuery`. Hides matches and wins over `tagQuery`. */
  excludeQuery: string;
  showTruapi: boolean;
  showSystem: boolean;
};

/** Every direction filter, in display order. `both` hides no direction. */
export const DIRECTION_FILTERS = ['both', 'outgoing', 'incoming'] as const;

/** The filters a new panel starts with, which hide nothing. Never throws. */
export function createInitialFilterState(): FilterState {
  return {
    direction: 'both',
    product: undefined,
    tagQuery: '',
    excludeQuery: '',
    showTruapi: true,
    showSystem: true,
  };
}
