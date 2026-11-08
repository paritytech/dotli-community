// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { m } from './metrics.js';
import type { MetricAttributes } from './types.js';

/** The attributes of one count: an outcome from its metric's own set, and keys from a closed set. */
export type CountAttributes<Outcome extends string> = MetricAttributes &
  ([Outcome] extends [never] ? { outcome?: never } : { outcome: Outcome });

/** A count a feature declares beside its code, with the outcomes it may count. */
export type CountMetric<Outcome extends string = never> = ReturnType<typeof defineCount<Outcome>>;

/** Counts one outcome of a declared metric, for a module that takes its counting as a param. Never throws. */
export type CountSink = <Outcome extends string>(
  metric: CountMetric<Outcome>,
  attributes: CountAttributes<Outcome>,
) => void;

/**
 * Declares a count metric. Its outcome set is the type argument, and a count without outcomes passes none.
 *
 * @example
 * const qrRenderMetric = defineCount<'error'>('auth.qr_render');
 * qrRenderMetric.count({ outcome: 'error', reason: 'TypeError' });
 */
export function defineCount<Outcome extends string = never>(name: string) {
  // A declaration, not a method, so its type is a property and the outcome stays checked on assignment
  function count(attributes: CountAttributes<Outcome>): void {
    m.count(name, attributes);
  }

  return Object.freeze({
    /** The metric's name without the `dotli.` prefix. */
    name,
    /** Adds one to the count with `attributes`. Never throws. */
    count,
  });
}

/** The sink that counts through the metric itself. Never throws. */
export function countMetric<Outcome extends string>(
  metric: CountMetric<Outcome>,
  attributes: CountAttributes<Outcome>,
): void {
  metric.count(attributes);
}
