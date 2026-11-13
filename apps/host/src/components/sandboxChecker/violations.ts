// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The violation panel's rules, apart from its DOM. Violation fields come from the product.

import { parseApiViolationMessage } from '@dotli/sandbox-wire';

export type ParsedViolation = {
  api: string;
  details: string;
  timestamp: number;
};

const MIN_HEIGHT = 40;
const MAX_VIEWPORT_SHARE = 0.8;
/** Older entries are dropped, but the badge still counts them. */
const MAX_ENTRIES = 500;

/** The violation a message reports, or null when another window sent it or it is not one. */
export function violationFrom(
  message: { source: unknown; data: unknown },
  product: unknown,
  now: () => number = Date.now,
): ParsedViolation | null {
  if (message.source !== product) {
    return null;
  }
  const parsed = parseApiViolationMessage(message.data);
  if (parsed === null) {
    return null;
  }
  return {
    api: parsed.api,
    details: Object.entries(parsed.details ?? {})
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' '),
    timestamp: parsed.timestamp ?? now(),
  };
}

/** Adds `entry` in place and drops the oldest past {@link MAX_ENTRIES}, since a copy per violation is quadratic. */
export function appendViolation<T>(entries: T[], entry: T): void {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.shift();
  }
}

/** The panel height for a drag at `clientY`, at least 40 px and at most 80 % of the viewport. */
export function clampPanelHeight(clientY: number, viewportHeight: number): number {
  return Math.max(MIN_HEIGHT, Math.min(viewportHeight - clientY, viewportHeight * MAX_VIEWPORT_SHARE));
}
