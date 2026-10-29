// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** In px. */
export type DockInset = {
  right: number;
  bottom: number;
};

export type DockSource = 'debug' | 'sandbox-checker';

/** Where the frame sits, before it becomes inline style. */
export type FrameBox = {
  /** The frame starts below the bar. Otherwise it takes the full safe height. */
  belowBar: boolean;
  /** In px, reserved at the right edge by chat and the docks there. */
  right: number;
  /** In px, reserved at the bottom edge by the docks there. */
  bottom: number;
};

type Params = {
  topbarOffset: boolean;
  /** In px, 0 while the chat panel is closed. */
  chatWidth: number;
  docks: Partial<Record<DockSource, DockInset>>;
};

/** Returns the box for the reported layout. Docks at the same edge stack, so their insets add up. Never throws. */
export function getFrameBox({ topbarOffset, chatWidth, docks }: Params): FrameBox {
  let right = chatWidth;
  let bottom = 0;
  for (const dock of Object.values(docks)) {
    right += dock.right;
    bottom += dock.bottom;
  }
  return { belowBar: topbarOffset, right, bottom };
}
