// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { StatusTone } from '../../page/status-tone.js';

/**
 * How a view's button reads as a row of a bar's More menu, for the page that puts the view in a collapsing bar. The
 * changing members are getters over the view's props, so a reader that tracks them follows the view.
 */
export interface MoreRow {
  readonly label: string;
  /** Rendered afresh for each row. */
  readonly icon: () => JSX.Element;
  /** A status More raises while the view is one of its rows: the badge's tone, and words for More's name. */
  readonly alert?: { readonly tone: StatusTone; readonly label: string } | undefined;
  /** Shown after the row's label. */
  readonly aside?: (() => JSX.Element) | undefined;
}
