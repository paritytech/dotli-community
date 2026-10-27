// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The computations the panel repeats as traffic arrives. Read from a context the mount fills, so a caller can count the
// panel's work per frame, click and tick.

import { createContext, useContext } from 'solid-js';
import { buildResolution } from './model/buildResolution.js';
import { buildTimeline } from './model/buildTimeline.js';
import { formatPending } from './model/formatPending.js';
import { matchesFilters } from './model/matchesFilters.js';
import { getRowSelection } from './model/getRowSelection.js';
import { createKeyedSignals } from './createKeyedSignals.js';

export type PanelWork = {
  matchesFilters: typeof matchesFilters;
  formatPending: typeof formatPending;
  getRowSelection: typeof getRowSelection;
  buildTimeline: typeof buildTimeline;
  buildResolution: typeof buildResolution;
  createKeyedSignals: typeof createKeyedSignals;
};

export const panelWork: PanelWork = {
  matchesFilters,
  formatPending,
  getRowSelection,
  buildTimeline,
  buildResolution,
  createKeyedSignals,
};

/** The work the panel's views run. The page's by default, and a mount may give its own to count it. */
export const PanelWorkContext = createContext<PanelWork>(panelWork);

/** The panel work the nearest mount provides, or the page's outside one. Never throws. */
export function usePanelWork(): PanelWork {
  return useContext(PanelWorkContext);
}
