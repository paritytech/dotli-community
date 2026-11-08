// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Dashboards slice on the named keys, so keep new attributes within them. */
export type MetricAttributes = {
  mode?: string;
  provider?: string;
  chain?: string;
  source?: string;
  env?: string;
  outcome?: string;
  reason?: string;
  owner?: string;
} & Record<string, string>;

/** The options of a metric sample. */
export type MetricParams = {
  /** The unit the value is in. Each metric kind sets its own default. */
  unit?: string | undefined;
  /** Attributes of this sample, merged over the session defaults. */
  attributes?: MetricAttributes | undefined;
};

/** The options of a measurement on the active span. */
export type MeasureParams = {
  /** The unit the value is in, milliseconds by default. */
  unit?: 'millisecond' | 'second' | 'byte' | 'none' | undefined;
};

/** The options of a timer. */
export type TimerParams = {
  /** The clock read at the start and at the stop, a monotonic one by default. */
  now?: (() => number) | undefined;
};

export type SpanValue = string | number | boolean;

/** Structural view of a span the SDK started, so the metrics API carries no SDK type. */
export type SentrySpan = {
  /** Sets attributes on the span. */
  setAttributes: (attributes: Record<string, SpanValue>) => void;
  /** Ends the span at `endTime`, epoch milliseconds, or now. */
  end: (endTime?: number) => void;
};
