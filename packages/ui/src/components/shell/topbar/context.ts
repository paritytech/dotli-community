// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { StatusTone } from '../../primitives/StatusDot.js';

/** A status a collapsed item raises on More: the badge's tone, and words for More's accessible name. */
export interface TopbarAlert {
  readonly tone: StatusTone;
  readonly label: string;
}

export interface TopbarEntry {
  /** A stable key, also the menu row's `data-item`. */
  readonly name: string;
  readonly label: string;
  /** Rendered afresh for each row. */
  readonly icon: () => JSX.Element;
  /** Raised on the More button while the item is in the menu. */
  readonly alert: Accessor<TopbarAlert | undefined>;
  /** Shown after the menu row's label. */
  readonly aside: Accessor<(() => JSX.Element) | undefined>;
  /** See TOPBAR_PRIORITY. */
  readonly priority: number;
  /** Whether the item shows at all, inline or as a row. */
  readonly visible: Accessor<boolean>;
  /** Does what a click on the item's button does. The row click's `detail` is 0 for a keyboard choice. */
  readonly activate: (ev: MouseEvent) => void;
  /** The element the bar measures and collapses. */
  readonly element: () => HTMLElement | undefined;
}

export interface TopbarBar {
  /** Add an item in bar order until the caller is disposed. Returns whether the bar has moved it into More. */
  register: (entry: TopbarEntry) => Accessor<boolean>;
  /** Measure `el` again whenever its size changes, until it is disposed. */
  observe: (el: HTMLElement) => void;
  /** The More button, which takes focus for a collapsed item. */
  moreButton: () => HTMLElement | undefined;
}

/** Null outside a bar, as on the landing page. */
export const TopbarContext = createContext<TopbarBar | null>(null);
