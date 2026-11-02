// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { formatMs } from './formatMs.js';

type AxisTick = {
  left: string;
  label: string;
};

const AXIS_TICKS = 5;

/** The time axis ticks of a chart `span` ms wide, evenly spaced from zero to the end. Never throws. */
export function listAxisTicks(span: number): AxisTick[] {
  return Array.from({ length: AXIS_TICKS + 1 }, (_, index) => ({
    left: `${((index / AXIS_TICKS) * 100).toFixed(3)}%`,
    label: formatMs((span * index) / AXIS_TICKS),
  }));
}
