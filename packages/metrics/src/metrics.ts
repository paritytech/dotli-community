// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Sentry spans and metrics. Every call is a no-op unless VITE_METRICS is "true".

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
  | 'unsupported-version';

/** Dashboards slice on the named keys, so keep new attributes within them. */
export type MetricAttributes = {
  mode?: string;
  provider?: string;
  chain?: string;
  source?: string;
  env?: string;
  outcome?: MetricOutcome;
  reason?: string;
} & Record<string, string>;

interface MetricOptions {
  unit?: string;
  attributes?: Record<string, string> | undefined;
}

interface SentrySpan {
  setAttributes: (attrs: Record<string, SpanValue>) => void;
  end: (endTime?: number) => void;
}

export type SpanValue = string | number | boolean;

interface SentryLike {
  startSpan: <T>(
    opts: { op: string; name: string },
    fn: (span: { setAttribute: (key: string, value: string) => void } | undefined) => T,
  ) => T;
  startInactiveSpan: (opts: {
    name: string;
    op?: string;
    startTime?: number | undefined;
    parentSpan?: unknown;
    forceTransaction?: boolean | undefined;
    attributes?: Record<string, SpanValue>;
  }) => SentrySpan;
  setMeasurement: (name: string, value: number, unit: string) => void;
  metrics: {
    count: (name: string, value?: number, opts?: MetricOptions) => void;
    distribution: (name: string, value: number, opts?: MetricOptions) => void;
    gauge: (name: string, value: number, opts?: MetricOptions) => void;
  };
  setTag: (key: string, value: string) => void;
  addBreadcrumb: (breadcrumb: {
    category: string;
    message: string;
    level?: string;
    data?: Record<string, unknown> | undefined;
  }) => void;
}

// Re-probed while null, so a late `initSentry` or `m.bind` still activates the pipeline.
let _sentry: SentryLike | null = null;

function sentry(): SentryLike | null {
  if (_sentry !== null) {
    return _sentry;
  }
  try {
    const hub = (globalThis as Record<string, unknown>)['__SENTRY_HUB__'];
    if (hub !== undefined && hub !== null) {
      _sentry = hub as SentryLike;
    }
    // eslint-disable-next-line no-restricted-syntax -- globalThis access can throw in restrictive contexts; we retry on next call instead of capturing (a capture would itself run through the metrics pipeline we're trying to probe).
  } catch {
    /* probe failure, try again next time */
  }
  if (_sentry === null) {
    warnUnboundOnce();
  }
  return _sentry;
}

// Without it, VITE_METRICS=true with no `m.bind()` silently flat-lines every dashboard.
// Not gated by DEBUG, so an operator with devtools open notices.
let _unboundWarned = false;
function warnUnboundOnce(): void {
  if (_unboundWarned || !ENABLED) {
    return;
  }
  _unboundWarned = true;
  console.warn(
    '[dot.li metrics] VITE_METRICS=true but Sentry is not bound — every metric will silently no-op until `initSentry()` / `m.bind()` runs. Check your app entry point.',
  );
}

/**
 * Bind a live Sentry after `Sentry.init()`.
 * Pass the functions, not the namespace: a namespace value keeps every SDK export in the bundle.
 */
function bind(s: SentryLike): void {
  _sentry = s;
  _unboundWarned = false;
}

const ENABLED = import.meta.env.VITE_METRICS === 'true';

let defaultAttrs: Record<string, string> = {};

function mergeAttrs(attrs?: Record<string, string>): Record<string, string> | undefined {
  if (attrs === undefined) {
    return Object.keys(defaultAttrs).length > 0 ? defaultAttrs : undefined;
  }
  return { ...defaultAttrs, ...attrs };
}

/** Run `fn` inside a Sentry span, handing it the span so it can attach attributes. */
function span<T>(name: string, fn: (span: { setAttribute: (key: string, value: string) => void } | undefined) => T): T;
function span<T>(
  name: string,
  fn: (span: { setAttribute: (key: string, value: string) => void } | undefined) => Promise<T>,
): Promise<T>;
function span<T>(
  name: string,
  fn: (span: { setAttribute: (key: string, value: string) => void } | undefined) => T | Promise<T>,
): T | Promise<T> {
  if (!ENABLED) {
    return fn(undefined);
  }
  const s = sentry();
  if (s === null) {
    return fn(undefined);
  }
  return s.startSpan({ op: 'dotli', name: `dotli.${name}` }, currentSpan => fn(currentSpan));
}

function measure(name: string, value: number, unit: 'millisecond' | 'second' | 'byte' | 'none' = 'millisecond'): void {
  if (!ENABLED) {
    return;
  }
  sentry()?.setMeasurement(`dotli.${name}`, value, unit);
}

function count(name: string, attributes?: MetricAttributes): void {
  if (!ENABLED) {
    return;
  }
  sentry()?.metrics.count(`dotli.${name}`, 1, {
    attributes: mergeAttrs(attributes),
  });
}

function distribution(name: string, value: number, unit = 'millisecond', attributes?: MetricAttributes): void {
  if (!ENABLED) {
    return;
  }
  sentry()?.metrics.distribution(`dotli.${name}`, value, {
    unit,
    attributes: mergeAttrs(attributes),
  });
}

function gauge(name: string, value: number, unit = 'none', attributes?: MetricAttributes): void {
  if (!ENABLED) {
    return;
  }
  sentry()?.metrics.gauge(`dotli.${name}`, value, {
    unit,
    attributes: mergeAttrs(attributes),
  });
}

function tag(key: string, value: string): void {
  if (!ENABLED) {
    return;
  }
  sentry()?.setTag(`dotli.${key}`, value);
}

/**
 * Add session-wide attributes to every later metric, mirrored to the Sentry scope as `dotli.<key>` tags.
 * Per-call attributes win. Pass bare keys: a prefixed one ends up as `dotli.dotli_<name>`.
 */
function setDefaults(attrs: Record<string, string>): void {
  if (!ENABLED) {
    return;
  }
  defaultAttrs = { ...defaultAttrs, ...attrs };
  const s = sentry();
  if (s === null) {
    return;
  }
  for (const [key, value] of Object.entries(attrs)) {
    s.setTag(`dotli.${key}`, value);
  }
}

/** Remove session-wide defaults, all of them when `keys` is omitted, so a mid-session switch leaks no stale tag. */
function clearDefaults(keys?: readonly string[]): void {
  if (!ENABLED) {
    return;
  }
  const targets: string[] = keys === undefined ? Object.keys(defaultAttrs) : [...keys];
  const s = sentry();
  for (const key of targets) {
    // Sentry has no tag removal, and an empty value drops out of non-empty filters.
    s?.setTag(`dotli.${key}`, '');
  }
  if (keys === undefined) {
    defaultAttrs = {};
  } else {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(defaultAttrs)) {
      if (!targets.includes(k)) {
        next[k] = v;
      }
    }
    defaultAttrs = next;
  }
}

let resolutionId: string | null = null;

/**
 * Correlate one page load across host, protocol iframe and sandbox, each with its own Sentry trace.
 * Stored even when metrics are stripped, because the realms that pass it on read it back from here.
 */
export function setResolutionId(id: string): void {
  resolutionId = id;
  setDefaults({ resolution_id: id });
}

/** The correlation id of the current page load, or null before the host mints it. */
export function getResolutionId(): string | null {
  return resolutionId;
}

/** A span that outlives its call, for work that opens and closes on separate messages. */
export interface SpanHandle {
  /** Ignored after `end`. */
  setAttributes: (attrs: Record<string, SpanValue>) => void;
  child: (name: string, opts?: OpenSpanOptions) => SpanHandle;
  /** Repeat calls are ignored, so a failure path can end a span the success path already ended. */
  end: (endTime?: number) => void;
}

export interface OpenSpanOptions {
  /** Epoch milliseconds, defaults to now. */
  startTime?: number;
  attributes?: Record<string, SpanValue>;
  /** Present the span as its own transaction in Sentry rather than a nested row. */
  root?: boolean;
}

const NOOP_HANDLE: SpanHandle = {
  setAttributes: () => {
    /* no span to attribute */
  },
  child: () => NOOP_HANDLE,
  end: () => {
    /* no span to end */
  },
};

// `captureException` makes the span active so the error joins its trace. Weak so the span dies with its handle.
const sentrySpans = new WeakMap<SpanHandle, SentrySpan>();

/** Package-private. Undefined for an inert handle. */
export function sentrySpanOf(handle: SpanHandle): unknown {
  return sentrySpans.get(handle);
}

function wrap(sentrySpan: SentrySpan): SpanHandle {
  let ended = false;
  const handle: SpanHandle = {
    setAttributes: attrs => {
      if (ended) {
        return;
      }
      sentrySpan.setAttributes(attrs);
    },
    child: (name, opts) => open(name, { ...opts, parent: sentrySpan }),
    end: endTime => {
      if (ended) {
        return;
      }
      ended = true;
      sentrySpan.end(endTime);
    },
  };
  sentrySpans.set(handle, sentrySpan);
  return handle;
}

/** Open a span closed later. Inert when metrics are off or Sentry is unbound, so callers never branch. */
function open(name: string, opts?: OpenSpanOptions & { parent?: unknown }): SpanHandle {
  if (!ENABLED) {
    return NOOP_HANDLE;
  }
  const s = sentry();
  if (s === null) {
    return NOOP_HANDLE;
  }
  return wrap(
    s.startInactiveSpan({
      name: `dotli.${name}`,
      op: 'dotli',
      startTime: opts?.startTime,
      // `null` makes a root. Undefined would silently adopt whatever span is active.
      parentSpan: opts?.root === true ? null : opts?.parent,
      forceTransaction: opts?.root,
      attributes: { ...defaultAttrs, ...opts?.attributes },
    }),
  );
}

function breadcrumb(message: string, data?: Record<string, unknown>): void {
  if (!ENABLED) {
    return;
  }
  sentry()?.addBreadcrumb({
    category: 'dotli',
    message,
    level: 'info',
    data,
  });
}

function timer(name: string): () => number {
  if (!ENABLED) {
    return () => 0;
  }
  const t0 = performance.now();
  return () => {
    const ms = performance.now() - t0;
    measure(name, ms);
    distribution(name, ms);
    return ms;
  };
}

export const m = {
  enabled: ENABLED,
  bind,
  span,
  open,
  measure,
  count,
  distribution,
  gauge,
  tag,
  setDefaults,
  clearDefaults,
  breadcrumb,
  timer,
} as const;
