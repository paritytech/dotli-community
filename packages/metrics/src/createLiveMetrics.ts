// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSpanHandle, INERT_SPAN_HANDLE, type OpenSpanParams, type SpanHandle } from './createSpanHandle.js';
import type { MeasureParams, MetricAttributes, MetricParams, SentrySpan, SpanValue, TimerParams } from './types.js';

export type Metrics = Readonly<ReturnType<typeof createLiveMetrics>>;

/** The span a `span` callback receives, to attach attributes to. */
type ActiveSpan = {
  /** Sets one attribute on the span. */
  setAttribute: (key: string, value: string) => void;
};

/** The options the SDK takes with a metric sample. */
type MetricOptions = {
  /** The unit the value is in. */
  unit?: string;
  /** Attributes of this sample. */
  attributes?: Record<string, string> | undefined;
};

/** Structural view of the SDK functions the metrics API calls. The caller supplies it, so a test can pass a recorder. */
type SentryLike = {
  /** Runs `fn` inside a new span that is active while it runs, and returns what `fn` returns. */
  startSpan: <Result>(options: { op: string; name: string }, fn: (span: ActiveSpan | undefined) => Result) => Result;
  /** Starts a span that stays open until its `end`, without making it active. */
  startInactiveSpan: (options: {
    name: string;
    op?: string;
    startTime?: number | undefined;
    parentSpan?: unknown;
    forceTransaction?: boolean | undefined;
    attributes?: Record<string, SpanValue>;
  }) => SentrySpan;
  /** Sets a measurement on the active span. */
  setMeasurement: (name: string, value: number, unit: string) => void;
  /** Records metric samples. */
  metrics: {
    /** Adds `value`, one by default, to the counter `name`. */
    count: (name: string, value?: number, options?: MetricOptions) => void;
    /** Records one sample of the distribution `name`. */
    distribution: (name: string, value: number, options?: MetricOptions) => void;
    /** Records the current value of the gauge `name`. */
    gauge: (name: string, value: number, options?: MetricOptions) => void;
  };
  /** Sets a tag on the current scope, so every later event carries it. */
  setTag: (key: string, value: string) => void;
  /** Adds a breadcrumb that later events carry. */
  addBreadcrumb: (breadcrumb: {
    category: string;
    message: string;
    level?: string;
    data?: Record<string, unknown> | undefined;
  }) => void;
};

/** The metrics API of a build with metrics, which reports to the Sentry bound with `bind` and drops calls before it. */
export function createLiveMetrics() {
  let bound: SentryLike | null = null;
  let defaultAttributes: Record<string, string> = {};

  function bind(sentry: SentryLike): () => void {
    const previous = bound;
    bound = sentry;

    function restore(): void {
      bound = previous;
    }

    return restore;
  }

  function mergeAttributes(attributes?: Record<string, string>): Record<string, string> | undefined {
    if (attributes === undefined) {
      return Object.keys(defaultAttributes).length > 0 ? defaultAttributes : undefined;
    }
    return { ...defaultAttributes, ...attributes };
  }

  function span<Result>(name: string, fn: (span: ActiveSpan | undefined) => Result): Result;
  function span<Result>(name: string, fn: (span: ActiveSpan | undefined) => Promise<Result>): Promise<Result>;
  function span<Result>(
    name: string,
    fn: (span: ActiveSpan | undefined) => Result | Promise<Result>,
  ): Result | Promise<Result> {
    const sentry = bound;
    if (sentry === null) {
      return fn(undefined);
    }
    return sentry.startSpan({ op: 'dotli', name: `dotli.${name}` }, currentSpan => fn(currentSpan));
  }

  function measure(name: string, value: number, { unit = 'millisecond' }: MeasureParams = {}): void {
    bound?.setMeasurement(`dotli.${name}`, value, unit);
  }

  function count(name: string, attributes?: MetricAttributes): void {
    bound?.metrics.count(`dotli.${name}`, 1, {
      attributes: mergeAttributes(attributes),
    });
  }

  function distribution(name: string, value: number, { unit = 'millisecond', attributes }: MetricParams = {}): void {
    bound?.metrics.distribution(`dotli.${name}`, value, {
      unit,
      attributes: mergeAttributes(attributes),
    });
  }

  function gauge(name: string, value: number, { unit = 'none', attributes }: MetricParams = {}): void {
    bound?.metrics.gauge(`dotli.${name}`, value, {
      unit,
      attributes: mergeAttributes(attributes),
    });
  }

  function tag(key: string, value: string): void {
    bound?.setTag(`dotli.${key}`, value);
  }

  function setDefaults(attributes: Record<string, string>): void {
    defaultAttributes = { ...defaultAttributes, ...attributes };
    const sentry = bound;
    if (sentry === null) {
      return;
    }
    for (const [key, value] of Object.entries(attributes)) {
      sentry.setTag(`dotli.${key}`, value);
    }
  }

  function clearDefaults(keys?: readonly string[]): void {
    const targets: string[] = keys === undefined ? Object.keys(defaultAttributes) : [...keys];
    const sentry = bound;
    for (const key of targets) {
      // Sentry has no tag removal, and an empty value drops out of non-empty filters.
      sentry?.setTag(`dotli.${key}`, '');
    }
    if (keys === undefined) {
      defaultAttributes = {};
    } else {
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(defaultAttributes)) {
        if (!targets.includes(key)) {
          next[key] = value;
        }
      }
      defaultAttributes = next;
    }
  }

  function open(name: string, options?: OpenSpanParams & { parent?: unknown }): SpanHandle {
    const sentry = bound;
    if (sentry === null) {
      return INERT_SPAN_HANDLE;
    }
    const sentrySpan = sentry.startInactiveSpan({
      name: `dotli.${name}`,
      op: 'dotli',
      startTime: options?.startTime,
      // `null` makes a root. Undefined would silently adopt whatever span is active.
      parentSpan: options?.root === true ? null : options?.parent,
      forceTransaction: options?.root,
      attributes: { ...defaultAttributes, ...options?.attributes },
    });
    return createSpanHandle({
      sentrySpan,
      openChild: (childName, childOptions) => open(childName, { ...childOptions, parent: sentrySpan }),
    });
  }

  function breadcrumb(message: string, data?: Record<string, unknown>): void {
    bound?.addBreadcrumb({
      category: 'dotli',
      message,
      level: 'info',
      data,
    });
  }

  function timer(name: string, { now = () => performance.now() }: TimerParams = {}): () => number {
    const start = now();

    function stop(): number {
      const ms = now() - start;
      measure(name, ms);
      distribution(name, ms);
      return ms;
    }

    return stop;
  }

  return {
    /** Whether this build records metrics, so a caller can skip work whose only use is a metric. */
    enabled: true,
    /**
     * Bind a live Sentry after `Sentry.init()`. Returns a function that restores the binding before, so unbind in
     * reverse order. Pass the functions, not the namespace: a namespace value keeps every SDK export in the bundle.
     */
    bind,
    /** Run `fn` inside a Sentry span, handing it the span so it can attach attributes. Returns what `fn` returns. */
    span,
    /** Open a span closed later. Inert when metrics are off or Sentry is unbound, so callers never branch. */
    open,
    /** Set a measurement on the active span, in milliseconds by default. */
    measure,
    /** Count one occurrence, with the session defaults merged under `attributes`. */
    count,
    /** Record one sample of a distribution, in milliseconds by default, with the session defaults merged in. */
    distribution,
    /** Record the current value of a gauge, unitless by default, with the session defaults merged in. */
    gauge,
    /** Set a `dotli.<key>` tag on the Sentry scope. */
    tag,
    /**
     * Add session-wide attributes to every later metric, mirrored to the Sentry scope as `dotli.<key>` tags.
     * Per-call attributes win. Pass bare keys: a prefixed one ends up as `dotli.dotli_<name>`.
     */
    setDefaults,
    /** Remove session-wide defaults, all of them when `keys` is omitted, so a mid-session switch leaks no stale tag. */
    clearDefaults,
    /** Leave a `dotli` breadcrumb that later events carry. */
    breadcrumb,
    /**
     * Measures from now until the returned stop, on `now`, a monotonic clock by default. The stop records the elapsed
     * milliseconds as a measurement and a distribution, and returns them.
     */
    timer,
  };
}
