// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { StatusTone } from '../../primitives/StatusDot.js';

/**
 * A status an item raises on the More button while it is collapsed: the
 * badge's tone, and the words More's accessible name adds for it
 * ("network syncing", "chat has unread messages").
 */
export interface TopbarAlert {
  readonly tone: StatusTone;
  readonly label: string;
}

/** What a topbar item tells the bar it sits in (see TopbarItem). */
export interface TopbarEntry {
  /** A stable key, also the menu row's `data-item`. */
  readonly name: string;
  /** The menu row's text. */
  readonly label: string;
  /** The menu row's icon, rendered afresh for each row. */
  readonly icon: () => JSX.Element;
  /**
   * A status the More button raises while the item is in the menu (the
   * network's while it is not ok, the chat's while it has unread messages),
   * undefined for none.
   */
  readonly alert: Accessor<TopbarAlert | undefined>;
  /**
   * What the menu row shows after its label (the network's dot and verdict
   * word, the chat's unread count), undefined for nothing.
   */
  readonly aside: Accessor<(() => JSX.Element) | undefined>;
  /** See TOPBAR_PRIORITY. */
  readonly priority: number;
  /** Whether the item shows at all, inline or as a row. */
  readonly visible: Accessor<boolean>;
  /**
   * What choosing the item's row does: what a click on its button does,
   * with the row click, whose `detail` is 0 for a keyboard choice.
   */
  readonly activate: (ev: MouseEvent) => void;
  /** The element the bar measures and collapses. */
  readonly element: () => HTMLElement | undefined;
}

export interface TopbarBar {
  /**
   * Add an item, in bar order, until the calling component is disposed.
   * Returns whether the bar has moved it into the More menu.
   */
  register: (entry: TopbarEntry) => Accessor<boolean>;
  /** Measure `el` again whenever its size changes, until it is disposed. */
  observe: (el: HTMLElement) => void;
  /** The More button, which takes focus for a collapsed item. */
  moreButton: () => HTMLElement | undefined;
}

/** The bar an item sits in, or null outside one (the landing page). */
export const TopbarContext = createContext<TopbarBar | null>(null);
