// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A Sentry for tests that records what the page reports. Free of any test runner so every package's tests can share it.

import { m } from '../metrics.js';
import type { SpanValue } from '../types.js';

export type RecordingSentry = ReturnType<typeof bindRecordingSentry>;

export type RecordedMetric = {
  /** With the `dotli.` prefix, as Sentry receives it. */
  name: string;
  /** The sampled value. */
  value: number;
  /** The unit the page passed, undefined when it passed none. */
  unit: string | undefined;
  /** The attributes the page passed, undefined when it passed none. */
  attributes: Record<string, string> | undefined;
};

type Params = {
  /**
   * Given `restore` to run when the test finishes, such as the runner's `onTestFinished`. Taken as a parameter so this
   * module stays free of any test runner. Without it the recorder stays bound until `restore`.
   */
  onFinished?: (restore: () => void) => void;
  /** Called after each metric, measurement or tag is recorded, so a test can wait on a report instead of polling. */
  onRecord?: () => void;
};

/**
 * Bind a Sentry that records every metric, measurement and tag, and the attributes of each span started apart from the
 * active one, until `restore`.
 */
export function bindRecordingSentry({ onFinished, onRecord }: Params = {}) {
  const counts: RecordedMetric[] = [];
  const distributions: RecordedMetric[] = [];
  const gauges: RecordedMetric[] = [];
  const measurements: { name: string; value: number; unit: string }[] = [];
  const tags: { key: string; value: string }[] = [];
  const spans: { name: string; attributes: Record<string, SpanValue> }[] = [];

  function recordInto(list: RecordedMetric[]) {
    function record(
      name: string,
      value = 1,
      options?: { unit?: string; attributes?: Record<string, string> | undefined },
    ): void {
      list.push({ name, value, unit: options?.unit, attributes: options?.attributes });
      onRecord?.();
    }

    return record;
  }

  function counted(name: string): (Record<string, string> | undefined)[] {
    return counts.filter(c => c.name === `dotli.${name}`).map(c => c.attributes);
  }

  const restore = m.bind({
    startSpan: (_options, fn) => fn(undefined),
    startInactiveSpan: options => {
      const span = { name: options.name, attributes: { ...options.attributes } };
      spans.push(span);
      return {
        setAttributes: next => {
          Object.assign(span.attributes, next);
        },
        end: doNothing,
      };
    },
    setMeasurement: (name, value, unit) => {
      measurements.push({ name, value, unit });
      onRecord?.();
    },
    metrics: { count: recordInto(counts), distribution: recordInto(distributions), gauge: recordInto(gauges) },
    setTag: (key, value) => {
      tags.push({ key, value });
      onRecord?.();
    },
    addBreadcrumb: doNothing,
  });
  onFinished?.(restore);
  return {
    /** Each count, in order. */
    counts,
    /** Each distribution sample, in order. */
    distributions,
    /** Each gauge value, in order. */
    gauges,
    /** Each measurement set on the active span, in order. */
    measurements,
    /** Each tag set on the scope, in order. */
    tags,
    /** Each span started apart from the active one, with its attributes as they stand now. */
    spans,
    /** The attributes of each count named `dotli.<name>`, in order. */
    counted,
    /** Puts back the Sentry bound before this one. */
    restore,
  };
}

function doNothing(): void {
  /* nothing to record */
}
