// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { StatusTone } from '@dotli/ui-core';
import type { ActionAlert } from './actions-context.js';

const SEVERITY: Record<StatusTone, number> = { ok: 0, quiet: 0, idle: 1, info: 2, warn: 3, err: 4 };

/** The most severe tone raised, so an error outranks a notice. Undefined when none is. */
export function worstTone(alerts: readonly ActionAlert[]): StatusTone | undefined {
  return alerts.reduce<StatusTone | undefined>(
    (worst, alert) => (worst === undefined || SEVERITY[alert.tone] > SEVERITY[worst] ? alert.tone : worst),
    undefined,
  );
}

/** More's accessible name, which says every status its rows raise. */
export function moreLabel(alerts: readonly ActionAlert[]): string {
  return ['More', ...alerts.map(alert => alert.label)].join(', ');
}
