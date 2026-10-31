# `@dotli/metrics`

Metrics, spans and error capture over Sentry. Every call is a no-op unless metrics are on, which a build decides at
compile time.

## Responsibility

- The `m` metrics API, the span and metric names (`spans`) and the one outcome vocabulary.
- `captureException`, `reportDefect` and `reportExpected`, which forward to one bound sink and do not import the SDK.
- Sentry setup and global error handlers, in the Sentry modules apart from the rest.
- A recording Sentry for tests.
- Not logging. This package binds a sink to the logger.

## Design

- `m` is chosen once per build: the live API when the compile-time `VITE_METRICS` flag is on, an inert API of the same
  type when it is off, so a caller never branches.
- The `m` API and the capture functions hold no SDK import. The Sentry modules import it behind the same flag, so a
  build without metrics drops the SDK.
- Capture forwards to a bound sink. Tests bind their own sink instead of mocking the package. A `CaptureContext` carries
  a `Flow` and a stable snake_case `step`, which together form the issue fingerprint.
- A defect is reported with `reportDefect`: an issue, an error line and one count. An expected failure is reported with
  `reportExpected`: a breadcrumb, an optional warning and one count. Both count under the caller's outcome metric. A
  report may carry extra count attributes from a closed set, and its own `outcome` and `reason` win over them.
- The Sentry modules are the only ones that import `@sentry/browser`, a dependency of this package. They set the SDK up
  with a listed set of integrations, so the bundle carries only those, bind the capture and log sinks and set the
  `source` tag (`host`, `protocol`, `worker`, `sandbox`).
- `spans` is one object that lists every metric name without the `dotli.` prefix.
- The testing entry records counts, distributions, gauges, tags, the attributes of spans started apart from the active
  one, and captured exceptions. It needs no test runner.
- Lint holds this package to its own rules.

## Public API

### `@dotli/metrics`

- `m`, `MetricOutcome`, `SpanHandle`, `SpanValue`: the metrics API and its one outcome vocabulary. A sample's unit, its
  attributes and a timer's clock go in a trailing options object: `distribution(name, value, { unit, attributes })` in
  milliseconds by default, `gauge(name, value, { unit, attributes })` unitless by default,
  `measure(name, value, { unit })` in milliseconds by default and `timer(name, { now })` on a monotonic clock by
  default. `count(name, attributes)` and `breadcrumb(message, data)` take their record directly.
- `spans`: the metric names, imported as `spans as S`.
- `captureException`, `reportDefect`, `reportExpected`, `bindCaptureSink`, `CaptureContext`, `CaptureSink`, `Flow`.
- `reportListener`: the one report of a throwing listener, counted as `listener.delivery` with its `owner`.
- `initSentry`, `installGlobalErrorHandlers`.
- `flushTelemetry`: sends buffered telemetry within a timeout, for a context that closes without a page-hide flush. It
  resolves at once when metrics are off and never rejects.
- `getResolutionId`, `setResolutionId`: the id that ties a resolution's events together.

### `@dotli/metrics/testing`

- `bindRecordingSentry`, `RecordingSentry`, `RecordedMetric`: a recording Sentry that tests bind and restore.
- `recordCaptures`, `RecordedCapture`: records each captured exception's flow, step and tags, and its error when asked.

Never imported by shipped code.

### `@dotli/metrics/testing/setup`

A setup file for a test runner: importing it binds a recording Sentry for the whole run. Never imported by shipped code.
