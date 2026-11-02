// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Which way a divider runs. */
export type Orientation = 'horizontal' | 'vertical';

type Params = {
  key: string;
  /** Which way the divider runs. */
  orientation: Orientation;
  /** Shift held, for the larger step. */
  large: boolean;
  /** Alt, Ctrl or Meta held. */
  modified?: boolean;
};

/** How far one arrow press moves a divider, and with Shift held. */
const KEY_STEP_PX = 16;
const KEY_STEP_LARGE_PX = 64;

/**
 * How far a key moves a divider along the screen axis, right or down positive, or `null` for a key the divider leaves to
 * the page. A divider that runs across the panel moves up and down, one that runs along it left and right. With
 * `modified` every key is left to the browser, whose back and forward shortcuts use the arrows. Never throws.
 */
export function getKeyDelta({ key, orientation, large, modified = false }: Params): number | null {
  if (modified) {
    return null;
  }
  const step = large ? KEY_STEP_LARGE_PX : KEY_STEP_PX;
  const [back, forward] = getArrowKeys(orientation);
  if (key === back) {
    return -step;
  }
  if (key === forward) {
    return step;
  }
  return null;
}

function getArrowKeys(orientation: Orientation): readonly [string, string] {
  switch (orientation) {
    case 'horizontal':
      return ['ArrowUp', 'ArrowDown'];
    case 'vertical':
      return ['ArrowLeft', 'ArrowRight'];
  }
}
