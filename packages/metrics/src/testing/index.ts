// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A Sentry for tests that records what the page reports. Apart from the barrel so no browser bundle reaches it, and
// free of any test runner so every package's tests can share it.

import { bindCaptureSink } from '../capture.js';
import { m } from '../metrics.js';

export interface RecordedMetric {
  /** With the `dotli.` prefix, as Sentry receives it. */
  name: string;
  value: number;
  unit: string | undefined;
  attributes: Record<string, string> | undefined;
}

export interface RecordingSentry {
  counts: RecordedMetric[];
  distributions: RecordedMetric[];
  gauges: RecordedMetric[];
  measurements: { name: string; value: number; unit: string }[];
  tags: { key: string; value: string }[];
  /** The attributes of each count named `dotli.<name>`, in order. */
  counted: (name: string) => (Record<string, string> | undefined)[];
  /** Puts back the Sentry bound before this one. */
  restore: () => void;
}

export interface RecordingOptions {
  /**
   * Given `restore` to run when the test finishes, such as the runner's `onTestFinished`. Taken as a parameter so this
   * module stays free of any test runner. Without it the recorder stays bound until `restore`.
   */
  onFinished?: (restore: () => void) => void;
  /** Called after each metric, measurement or tag is recorded, so a test can wait on a report instead of polling. */
  onRecord?: () => void;
}

/** Bind a Sentry that records every metric, measurement and tag until `restore`. Spans run but are not recorded. */
export function bindRecordingSentry(options: RecordingOptions = {}): RecordingSentry {
  const counts: RecordedMetric[] = [];
  const distributions: RecordedMetric[] = [];
  const gauges: RecordedMetric[] = [];
  const measurements: RecordingSentry['measurements'] = [];
  const tags: RecordingSentry['tags'] = [];
  const recordInto =
    (list: RecordedMetric[]) =>
    (name: string, value = 1, opts?: { unit?: string; attributes?: Record<string, string> | undefined }): void => {
      list.push({ name, value, unit: opts?.unit, attributes: opts?.attributes });
      options.onRecord?.();
    };
  const inert = (): void => undefined;
  const restore = m.bind({
    startSpan: (_opts, fn) => fn(undefined),
    startInactiveSpan: () => ({ setAttributes: inert, end: inert }),
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
    counted: name => counts.filter(c => c.name === `dotli.${name}`).map(c => c.attributes),
    restore,
  };
}

export interface RecordedCapture {
  step: string;
  tags: Record<string, string> | undefined;
}

/** Records each captured exception's step and tags, until `onFinished` puts back the sink bound before. */
export function recordCaptures(options: { onFinished: (restore: () => void) => void }): RecordedCapture[] {
  const captured: RecordedCapture[] = [];
  options.onFinished(
    bindCaptureSink({
      exception: (_err, ctx) => captured.push({ step: ctx.step, tags: ctx.tags }),
      expected: () => undefined,
    }),
  );
  return captured;
}
