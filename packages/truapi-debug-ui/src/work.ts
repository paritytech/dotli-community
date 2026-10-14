// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The computations the panel repeats as traffic arrives. Read from a context the mount fills, so a caller can count the
// panel's work per frame, click and tick.

import { createContext, useContext } from 'solid-js';
import { buildResolution } from './model/resolution-view.js';
import { buildTimeline } from './model/timeline.js';
import { formatPending } from './model/pending.js';
import { matches } from './model/filters.js';
import { rowSelection } from './model/row-format.js';
import { createKeyedSignals } from './keyed-signals.js';

export interface PanelWork {
  matches: typeof matches;
  formatPending: typeof formatPending;
  rowSelection: typeof rowSelection;
  buildTimeline: typeof buildTimeline;
  buildResolution: typeof buildResolution;
  createKeyedSignals: typeof createKeyedSignals;
}

export const panelWork: PanelWork = {
  matches,
  formatPending,
  rowSelection,
  buildTimeline,
  buildResolution,
  createKeyedSignals,
};

/** The work the panel's views run. The page's by default, and a mount may give its own to count it. */
export const PanelWorkContext = createContext<PanelWork>(panelWork);

export function usePanelWork(): PanelWork {
  return useContext(PanelWorkContext);
}
