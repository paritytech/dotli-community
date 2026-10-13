// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the error page shows and the order its actions render in.

import type { Component } from 'solid-js';
import type { IconProps } from '@dotli/ui/icons';

export interface ErrorAction {
  label: string;
  onClick: (event: MouseEvent) => void;
  /** Rendered last whatever its array position. Defaults to the first action. */
  primary?: boolean;
  /** Leads the label. */
  icon?: Component<IconProps>;
}

/** Segments rather than markup, so every piece goes in as text. */
export type ErrorText = string | readonly (string | { strong: string })[];

export interface ErrorPageContent {
  title: string;
  detail?: ErrorText | undefined;
  /** Listed under a "Try" heading. */
  tips?: readonly string[];
  /** The first keeps `#error-retry-btn` whichever one is `primary`. */
  actions?: readonly ErrorAction[];
  glyph?: 'warning';
}

/** An action as the page renders it. */
export interface ArrangedAction {
  action: ErrorAction;
  /** By array position, so the first action keeps `error-retry-btn` wherever it renders. */
  id: string;
  primary: boolean;
}

/**
 * The actions in render order: the primary, the one marked or else the first, goes last, so reading, DOM and tab order
 * agree.
 */
export function arrangeErrorActions(actions: readonly ErrorAction[]): ArrangedAction[] {
  const idFor = (i: number): string => (i === 0 ? 'error-retry-btn' : `error-retry-btn-${String(i)}`);
  const declaredPrimary = actions.findIndex(a => a.primary === true);
  const primaryIndex = declaredPrimary === -1 ? 0 : declaredPrimary;
  return actions
    .map((action, i) => ({ action, id: idFor(i), primary: i === primaryIndex }))
    .sort((x, y) => Number(x.primary) - Number(y.primary));
}
