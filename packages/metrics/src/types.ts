// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Keep dashboards in sync with this list. */
export type MetricOutcome =
  | 'ok'
  | 'error'
  | 'timeout'
  | 'miss'
  | 'hit'
  | 'pending'
  // Bitswap
  | 'not-found'
  | 'invalid-cid'
  | 'aborted'
  // Manifest reader
  | 'empty'
  | 'invalid'
  | 'unsupported-version'
  // Cache revalidation
  | 'match'
  | 'update'
  | 'cleared'
  // Protocol wire
  | 'refused'
  // Phone requests: the connection ended before the phone answered, a frame did not decode, or a review could not
  // be matched
  | 'gone'
  | 'undecodable'
  | 'unmatchable'
  // Signed-in flag
  | 'dropped'
  | 'signed_out'
  | 'switched'
  | 'unreadable'
  // Sign-in and sign-out windows
  | 'opened'
  | 'blocked'
  | 'busy'
  | 'signed_in'
  | 'cancelled'
  | 'told_phone'
  | 'nothing'
  | 'kept'
  // A site's sign-in and transaction through the session window, and its revoke from the site list
  | 'granted'
  | 'signed'
  | 'failed'
  | 'revoked';

/** Dashboards slice on the named keys, so keep new attributes within them. */
export type MetricAttributes = {
  mode?: string;
  provider?: string;
  chain?: string;
  source?: string;
  env?: string;
  outcome?: MetricOutcome;
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
