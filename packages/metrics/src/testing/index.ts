// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A Sentry for tests that records what the page reports. Apart from the barrel so no browser bundle reaches it, and
// free of any test runner so every package's tests can share it.

import { bindCaptureSink, type Flow } from '../capture.js';
import { m, type SpanValue } from '../metrics.js';

export type RecordedMetric = {
  /** With the `dotli.` prefix, as Sentry receives it. */
  name: string;
  value: number;
  unit: string | undefined;
  attributes: Record<string, string> | undefined;
};

export type RecordingSentry = {
  counts: RecordedMetric[];
  distributions: RecordedMetric[];
  gauges: RecordedMetric[];
  measurements: { name: string; value: number; unit: string }[];
  tags: { key: string; value: string }[];
  /** Each span started apart from the active one, with its attributes as they stand now. */
  spans: { name: string; attributes: Record<string, SpanValue> }[];
  /** The attributes of each count named `dotli.<name>`, in order. */
  counted: (name: string) => (Record<string, string> | undefined)[];
  /** Puts back the Sentry bound before this one. */
  restore: () => void;
};

export type RecordingOptions = {
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
export function bindRecordingSentry(options: RecordingOptions = {}): RecordingSentry {
  const counts: RecordedMetric[] = [];
  const distributions: RecordedMetric[] = [];
  const gauges: RecordedMetric[] = [];
  const measurements: RecordingSentry['measurements'] = [];
  const tags: RecordingSentry['tags'] = [];
  const spans: RecordingSentry['spans'] = [];
  const recordInto =
    (list: RecordedMetric[]) =>
    (name: string, value = 1, opts?: { unit?: string; attributes?: Record<string, string> | undefined }): void => {
      list.push({ name, value, unit: opts?.unit, attributes: opts?.attributes });
      options.onRecord?.();
    };
  const inert = (): void => undefined;
  const restore = m.bind({
    startSpan: (_opts, fn) => fn(undefined),
    startInactiveSpan: opts => {
      const span = { name: opts.name, attributes: { ...opts.attributes } };
      spans.push(span);
      return {
        setAttributes: next => {
          Object.assign(span.attributes, next);
        },
        end: inert,
      };
    },
    setMeasurement: (name, value, unit) => {
      measurements.push({ name, value, unit });
      options.onRecord?.();
    },
    metrics: { count: recordInto(counts), distribution: recordInto(distributions), gauge: recordInto(gauges) },
    setTag: (key, value) => {
      tags.push({ key, value });
      options.onRecord?.();
    },
    addBreadcrumb: inert,
  });
  options.onFinished?.(restore);
  return {
    counts,
    distributions,
    gauges,
    measurements,
    tags,
    spans,
    counted: name => counts.filter(c => c.name === `dotli.${name}`).map(c => c.attributes),
    restore,
  };
}

export type RecordedCapture = {
  flow: Flow;
  step: string;
  tags: Record<string, string> | undefined;
};

/**
 * Records each captured exception's flow, step and tags, until `onFinished` puts back the sink bound before. Each captured
 * error is also pushed to `errors` when given.
 */
export function recordCaptures(options: {
  onFinished: (restore: () => void) => void;
  errors?: unknown[];
}): RecordedCapture[] {
  const captured: RecordedCapture[] = [];
  options.onFinished(
    bindCaptureSink({
      exception: (err, ctx) => {
        captured.push({ flow: ctx.flow, step: ctx.step, tags: ctx.tags });
        options.errors?.push(err);
      },
      expected: () => undefined,
    }),
  );
  return captured;
}
