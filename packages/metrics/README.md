# `@dotli/metrics`

Metrics, spans and error capture over Sentry. Every call is a no-op unless metrics are on, which a build decides at
compile time.

## Responsibility

- The `m` metrics API, the span and metric names (`spans`) and the one outcome vocabulary.
- `captureException` and `reportExpected`, which forward to one bound sink and do not import the SDK.
- Sentry setup and global error handlers, in a module apart from the rest.
- A recording Sentry for tests.
- Not logging. This package binds a sink to the shared `log`.

## Design

- The `m` API and the capture functions hold no SDK import. The Sentry module imports it behind the compile-time
  `VITE_METRICS` check, so a build without metrics drops the SDK.
- Capture forwards to a bound sink. Tests bind their own sink instead of mocking the package. A `CaptureContext` carries
  a `Flow` and a stable snake_case `step`, which together form the issue fingerprint.
- The Sentry module is the only one that imports `@sentry/browser`, a dependency of this package. It sets the SDK up
  with a listed set of integrations, so the bundle carries only those. It binds the capture and log sinks and sets the
  `source` tag (`host`, `protocol`, `worker`, `sandbox`).
- `spans` lists every metric name without the `dotli.` prefix.
- The testing entry records counts, distributions, gauges, tags and captured exceptions. It needs no test runner.
- Lint holds this package to its own rules.

## Public API

### `@dotli/metrics`

- `m`, `SpanHandle`, `SpanValue`: the metrics API.
- `spans`: the metric names, imported as `spans as S`.
- `captureException`, `reportExpected`, `recordExpected`, `bindCaptureSink`, `CaptureContext`, `CaptureSink`,
  `ExpectedReport`, `Flow`.
- `reportListener`: the one report of a throwing listener, counted as `listener.delivery` with its `owner`.
- `initSentry`, `installGlobalErrorHandlers`.
- `getResolutionId`, `setResolutionId`: the id that ties a resolution's events together.

### `@dotli/metrics/testing`

- `bindRecordingSentry`: a recording Sentry that tests bind and restore, and `recordCaptures`, which records each
  captured exception's flow, step and tags, and its error when asked. Never imported by shipped code.

### `@dotli/metrics/testing/setup`

A setup file for a test runner: importing it binds a recording Sentry for the whole run. Never imported by shipped code.
