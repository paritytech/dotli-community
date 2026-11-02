// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Plain values, so a redraw writes only the ones that changed.

import type { ResolutionBlock } from '../model/buildResolution.js';
import { formatMs } from './formatMs.js';

type BlockView = {
  phase: string;
  /** The phase itself, or `unknown` when it has no colour of its own. */
  tone: string;
  left: string;
  width: string;
  open: boolean;
  title: string;
};

type Params = {
  block: ResolutionBlock;
  /** The block is still running, so it runs to now. */
  open: boolean;
  /** The chart's width in ms. */
  span: number;
};

const COLOURED_PHASES = new Set(['connecting', 'syncing', 'ready', 'stalled']);

/** Where a phase block sits on a chart `span` ms wide, and its tooltip. `open` blocks run to now. Never throws. */
export function toBlockView({ block, open, span }: Params): BlockView {
  const end = block.endMs ?? span;
  const left = (block.startMs / span) * 100;
  const width = Math.max(0.4, ((end - block.startMs) / span) * 100);
  const title = [
    `${block.phase} for ${formatMs(end - block.startMs)}`,
    `from ${formatMs(block.startMs)} to ${open ? 'now' : formatMs(end)}`,
    block.reason,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  return {
    phase: block.phase,
    tone: COLOURED_PHASES.has(block.phase) ? block.phase : 'unknown',
    left: `${left.toFixed(3)}%`,
    width: `${width.toFixed(3)}%`,
    open,
    title,
  };
}
