// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { RecentLabels } from './createRecentLabels.js';
import { recentLabels } from './createLazyRecentLabels.js';

/** A window's own view and its top-level one. */
export type FrameView = {
  self: unknown;
  top: unknown;
};

type Params = {
  /** Returns the page's own list, the page's list store by default. */
  list?: (() => RecentLabels) | undefined;
};

/**
 * Returns the list a landing island shows when it is handed none: the page's own, or none on a page inside another
 * frame. dot.li does not start there, so its read would wait out the configure timeout of a protocol frame nothing
 * configures. Throws only as `list` does.
 */
export function getLandingRecentLabels(
  view: FrameView,
  { list = recentLabels.getStore }: Params = {},
): RecentLabels | undefined {
  return view.self === view.top ? list() : undefined;
}
