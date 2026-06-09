// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Performance metrics for smoldot/protocol lifecycle.
//
// Controlled via VITE_METRICS env var:
//   VITE_METRICS=true   spans, measurements, and counters sent to Sentry
//   VITE_METRICS unset  all calls are no-ops (zero overhead)
//
// Usage:
//   import { m } from "@dotli/metrics/metrics";
//   await m.span("smoldot.relay_chain", async () => { ... });
//   m.measure("smoldot.sync_duration", 2356);
//   m.count("protocol.mode", { mode: "shared-worker", outcome: "ok" });
//
// Approved attribute schema (`MetricAttributes`):
//   - `mode`      legacy DotliMode preset label ("p2p-shared-worker" etc.)
//   - `provider`  concrete provider name ("smoldot", "rpc", "helia", ...)
//   - `chain`     relay or parachain name ("relay", "asset-hub", ...)
//   - `source`    emitting module ("host", "worker", "sandbox", ...)
//   - `env`       deployment environment ("production", "staging", ...)
//   - `outcome`   "ok" | "error" | "timeout" | "miss" | "hit"
//   - `reason`    short error class tag when `outcome !== "ok"`
//
// Unknown keys are still accepted (TypeScript `& Record<string,string>`) so
// existing call sites compile. The named keys are the ones dashboards slice
// on, so keep new attributes within the schema.

/** Known metric attribute keys. Keep dashboards in sync with this list. */
export type MetricOutcome =
  | "ok"
  | "error"
  | "timeout"
  | "miss"
  | "hit"
  | "pending"
  // Bitswap
  | "not-found"
  | "invalid-cid"
  | "aborted"
  // Manifest reader
  | "empty"
  | "invalid";

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
  attributes?: Record<string, string>;
}

interface SentryLike {
  startSpan: <T>(
    opts: { op: string; name: string },
    fn: (
      span: { setAttribute: (key: string, value: string) => void } | undefined,
    ) => T,
  ) => T;
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
    data?: Record<string, unknown>;
  }) => void;
}

// Sentry resolves once at first use so the metrics package never forces a
// Sentry import. The host app must initialize Sentry before any metric calls
// fire.
//
// `sentry()` re-probes as long as `_sentry` is null. Memoizing the first null
// result would keep an app that initializes Sentry after the first metric call
// silent forever, so a late `initSentry` or `m.bind` still activates the
// pipeline the next time any metric fires.

let _sentry: SentryLike | null = null;

function sentry(): SentryLike | null {
  if (_sentry !== null) {
    return _sentry;
  }
  try {
    const hub = (globalThis as Record<string, unknown>).__SENTRY_HUB__;
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

// Single "metrics enabled but no Sentry bound" warning across the
// session. Without this, VITE_METRICS=true + a missing `m.bind()` call
// produces a silent flat-line on every dashboard. One console.warn is
// cheap, and we keep it always-on (not gated by DEBUG) so an operator
// with the devtools open notices before the pipeline is cold for hours.
let _unboundWarned = false;
function warnUnboundOnce(): void {
  if (_unboundWarned || !ENABLED) {
    return;
  }
  _unboundWarned = true;
  console.warn(
    "[dot.li metrics] VITE_METRICS=true but Sentry is not bound — every metric will silently no-op until `initSentry()` / `m.bind()` runs. Check your app entry point.",
  );
}

/**
 * Bind a live Sentry instance. Call this from the app entry point
 * after `Sentry.init()` so the metrics package can record spans.
 *
 * ```ts
 * import * as Sentry from "@sentry/browser";
 * import { m } from "@dotli/metrics/metrics";
 * Sentry.init({ ... });
 * m.bind(Sentry);
 * ```
 */
function bind(s: SentryLike): void {
  _sentry = s;
  _unboundWarned = false;
}

const ENABLED = (import.meta.env.VITE_METRICS as string | undefined) === "true";

// Apps register session-level context (e.g. `dotli_mode`) via `setDefaults()`.
// Every metric emitted afterwards carries these attributes, so dashboards can
// slice per-mode without touching each call site. Per-call attributes still
// win on collision.

let defaultAttrs: Record<string, string> = {};

function mergeAttrs(
  attrs?: Record<string, string>,
): Record<string, string> | undefined {
  if (attrs === undefined) {
    return Object.keys(defaultAttrs).length > 0 ? defaultAttrs : undefined;
  }
  return { ...defaultAttrs, ...attrs };
}

/**
 * Wrap a sync or async function in a Sentry performance span.
 * When metrics are disabled, the function runs without instrumentation.
 * The wrapped function receives the active span so callers can attach
 * attributes synchronously inside the body (e.g. `dotli.chain_backend`
 * on a resolve span).
 */
function span<T>(
  name: string,
  fn: (
    span: { setAttribute: (key: string, value: string) => void } | undefined,
  ) => T,
): T;
function span<T>(
  name: string,
  fn: (
    span: { setAttribute: (key: string, value: string) => void } | undefined,
  ) => Promise<T>,
): Promise<T>;
function span<T>(
  name: string,
  fn: (
    span: { setAttribute: (key: string, value: string) => void } | undefined,
  ) => T | Promise<T>,
): T | Promise<T> {
  if (!ENABLED) {
    return fn(undefined);
  }
  const s = sentry();
  if (s === null) {
    return fn(undefined);
  }
  return s.startSpan({ op: "dotli", name: `dotli.${name}` }, (currentSpan) =>
    fn(currentSpan),
  );
}

/**
 * Record a numeric measurement on the current Sentry transaction.
 * Measurements appear in Sentry's performance dashboard.
 */
function measure(
  name: string,
  value: number,
  unit: "millisecond" | "second" | "byte" | "none" = "millisecond",
): void {
  if (!ENABLED) {
    return;
  }
  sentry()?.setMeasurement(`dotli.${name}`, value, unit);
}

/**
 * Increment a counter metric. Counters track event frequency.
 *
 * `attributes` follows the approved `MetricAttributes` schema. Prefer the
 * named keys (`mode`, `provider`, `chain`, `source`, `outcome`,
 * `reason`) so dashboards can slice consistently.
 */
function count(name: string, attributes?: MetricAttributes): void {
  if (!ENABLED) {
    return;
  }
  sentry()?.metrics.count(`dotli.${name}`, 1, {
    attributes: mergeAttrs(attributes),
  });
}

/**
 * Record a distribution (histogram) value. Use for latency distributions.
 */
function distribution(
  name: string,
  value: number,
  unit = "millisecond",
  attributes?: MetricAttributes,
): void {
  if (!ENABLED) {
    return;
  }
  sentry()?.metrics.distribution(`dotli.${name}`, value, {
    unit,
    attributes: mergeAttrs(attributes),
  });
}

/**
 * Record a gauge value (last-write-wins). Use for current state values.
 */
function gauge(
  name: string,
  value: number,
  unit = "none",
  attributes?: MetricAttributes,
): void {
  if (!ENABLED) {
    return;
  }
  sentry()?.metrics.gauge(`dotli.${name}`, value, {
    unit,
    attributes: mergeAttrs(attributes),
  });
}

/**
 * Set a tag on the current Sentry scope. Tags are searchable in Sentry.
 */
function tag(key: string, value: string): void {
  if (!ENABLED) {
    return;
  }
  sentry()?.setTag(`dotli.${key}`, value);
}

/**
 * Register session-wide default attributes. Every `count`, `distribution`,
 * and `gauge` emitted afterwards picks these up automatically, so `source`,
 * `mode`, or any similar slice from the canonical `MetricAttributes` schema
 * doesn't need to be threaded through every call site.
 *
 * Keys passed here MUST be bare schema keys (`source`, `mode`, `chain`,
 * `provider`, etc.). The metrics layer owns the `dotli.`-prefix mirroring
 * to Sentry tags internally. Passing an already-prefixed key produces
 * `dotli.dotli_<name>` in Sentry and silently drifts from the schema.
 *
 * Each entry is mirrored to the Sentry scope as a `dotli.<key>` tag, so
 * error events inherit the same context for filtering. Per-call attributes
 * passed directly to `count` / `distribution` / `gauge` still win on key
 * collision.
 *
 * Call once per app at boot, after mode / context is known.
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

/**
 * Remove session-wide default attributes. Without this, switching chain
 * backend mid-session would leak the old `dotli_chain_backend` tag into
 * every subsequent metric, corrupting dashboards for the new mode.
 *
 * When `keys` is omitted, every registered default is cleared. When
 * `keys` is supplied, only those attributes are removed (and their
 * Sentry tags reset to the empty string, since Sentry has no `removeTag`).
 */
function clearDefaults(keys?: readonly string[]): void {
  if (!ENABLED) {
    return;
  }
  const targets: string[] =
    keys === undefined ? Object.keys(defaultAttrs) : [...keys];
  const s = sentry();
  for (const key of targets) {
    // Clear the scope tag by setting it to an empty string. Sentry has
    // no remove primitive, so dashboards filtering on a non-empty value
    // will stop picking up stale values.
    s?.setTag(`dotli.${key}`, "");
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

/**
 * Add a breadcrumb for debugging context. Breadcrumbs appear in error reports.
 */
function breadcrumb(message: string, data?: Record<string, unknown>): void {
  if (!ENABLED) {
    return;
  }
  sentry()?.addBreadcrumb({
    category: "dotli",
    message,
    level: "info",
    data,
  });
}

/**
 * Start a manual timer. Returns a function that, when called,
 * records the elapsed duration as both a measurement and distribution.
 */
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
  /** Whether metrics collection is active */
  enabled: ENABLED,
  /** Bind a live Sentry instance after Sentry.init() */
  bind,
  /** Wrap a function in a performance span */
  span,
  /** Record a numeric measurement */
  measure,
  /** Increment a counter */
  count,
  /** Record a distribution (histogram) value */
  distribution,
  /** Record a gauge value */
  gauge,
  /** Set a searchable tag */
  tag,
  /** Set session-wide default attributes (also mirrored to scope tags) */
  setDefaults,
  /** Remove session-wide defaults (all, or a specific subset) */
  clearDefaults,
  /** Add a debugging breadcrumb */
  breadcrumb,
  /** Start a manual timer, returns a stop function */
  timer,
} as const;
