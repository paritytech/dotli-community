// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { log } from '@dotli/shared';

/** Logs one anomaly of a kind, or only counts it once that kind has logged its first few. */
export type BrokerWarner = ReturnType<typeof createBrokerWarner>;

const BROKER_TAG = '[dot.li broker]';
// Anomalies warn so they reach Sentry breadcrumbs in every build. A broken chain repeats one on every
// message and would flood the trail, so each kind logs its first few, then a count at each power of ten.
const WARN_IN_FULL = 3;

/** Warns of one chain's anomalies, counted per kind so one broken chain cannot mute another's. */
export function createBrokerWarner() {
  const counts = new Map<string, number>();

  /** Logs one anomaly of `kind`, or only counts it once that kind has logged its first few. */
  function warn(kind: string, message: string): void {
    const count = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, count);
    if (count <= WARN_IN_FULL) {
      log.warn(`${BROKER_TAG} ${message}`);
    } else if (/^10+$/.test(String(count))) {
      log.warn(`${BROKER_TAG} ${kind}: ${String(count)} so far`);
    }
  }

  return warn;
}

/** Logs broker traffic at debug level, so per-message lines print only with VITE_APP_DEBUG. */
export function logBrokerTraffic(...args: unknown[]): void {
  log.debug(BROKER_TAG, ...args);
}
