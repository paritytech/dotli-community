# `@dotli/metrics`

Metrics, spans and error capture over Sentry. Every call is a no-op unless metrics are on, which a build decides at
compile time.

## Responsibility

- The `m` metrics API and the metric names more than one package reads (`spans`). It names no feature's flow, metric or
  outcome, since each feature declares its own.
- `createReporter`, the one way a feature reports: its flow on every capture, breadcrumb and log line, over one bound
  sink that imports no SDK.
- Sentry setup and global error handlers, in the Sentry modules apart from the rest.
- A recording Sentry for tests.
- Not logging. This package binds a sink to the logger.

## Design

- `m` is chosen once per build: the live API when the compile-time `VITE_METRICS` flag is on, an inert API of the same
  type when it is off, so a caller never branches.
- The `m` API and the capture functions hold no SDK import. The Sentry modules import it behind the same flag, so a
  build without metrics drops the SDK.
- Capture forwards to a bound sink. Tests bind their own sink instead of mocking the package. A `CaptureContext` carries
  the flow its feature names and a stable snake_case `step`, which together form the issue fingerprint.
- A defect is reported with `report.defect`: an issue, an error line and one count. An expected failure is reported with
  `report.expected`: a breadcrumb, an optional warning and one count. Both count under the caller's outcome metric. A
  report may carry extra count attributes from a closed set, and its own `outcome` and `reason` win over them.
- The Sentry modules are the only ones that import `@sentry/browser`, a dependency of this package. They set the SDK up
  with a listed set of integrations, so the bundle carries only those, bind the capture and log sinks and set the
  `source` tag (`host`, `protocol`, `worker`, `sandbox`).
- `spans` is one object that lists the metric names more than one package reads, without the `dotli.` prefix.
- A feature declares its own count metrics with their outcome sets, so a new outcome or metric edits the feature only.
- The testing entry records counts, distributions, gauges, tags, the attributes of spans started apart from the active
  one, and each reported failure, captured or expected, by step. It needs no test runner.
- Lint holds this package to its own rules.

## Public API

### `@dotli/metrics`

- `m`, `SpanHandle`, `SpanValue`: the metrics API. A sample's unit, its attributes and a timer's clock go in a trailing
  options object: `distribution(name, value, { unit, attributes })` in milliseconds by default,
  `gauge(name, value, { unit, attributes })` unitless by default, `measure(name, value, { unit })` in milliseconds by
  default and `timer(name, { now })` on a monotonic clock by default. `count(name, attributes)` and
  `breadcrumb(message, data)` take their record directly.
- `spans`: the metric names more than one package reads, imported as `spans as S`.
- `defineCount`, `CountMetric`, `CountAttributes`: a count a feature declares beside its code, with the outcome set it
  may count as the type argument. `CountSink`, `countMetric`: the type of a count taken as a param, and its default,
  which counts through the metric.
- `createReporter`, `Reporter`, `DefectParams`, `ExpectedParams`: a feature's reporter, built once with its flow. It
  carries `defect`, `expected`, `capture`, `listener` and a `log` whose every line carries the flow. `listener` reports
  a throwing listener, counted as `listener.delivery` with its `owner`. The reporter is the only way to report a defect,
  an expected failure or a capture.
- `bindCaptureSink`, `CaptureContext`, `CaptureSink`: the sink that issue captures forward to, which a context binds
  once.
- `initSentry`, `installGlobalErrorHandlers`.
- `flushTelemetry`: sends buffered telemetry within a timeout, for a context that closes without a page-hide flush. It
  resolves at once when metrics are off and never rejects, and reports a failure through the caller's reporter.
- `getResolutionId`, `setResolutionId`: the id that ties a resolution's events together.

### `@dotli/metrics/testing`

- `bindRecordingSentry`, `RecordingSentry`, `RecordedMetric`: a recording Sentry that tests bind and restore.
- `recordReports`, `RecordedReport`, `RecordedReports`: records each reported failure's step, error and tags, never its
  flow, for a spec to match partially.

Never imported by shipped code.

### `@dotli/metrics/testing/setup`

A setup file for a test runner: importing it binds a recording Sentry for the whole run. Never imported by shipped code.
