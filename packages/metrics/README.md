# `@dotli/metrics`

## Overview

Metrics, spans and error capture over Sentry. Every call is a no-op unless the build turns metrics on.

## Responsibilities

- **Owns** the `m` metrics API and `spans`, the metric names more than one package reads.
- **Owns** `createReporter`, the one way a feature reports.
- **Owns** Sentry setup, the global error handlers and a recording Sentry for tests.
- **Does not own** logging, or any feature's flow, metric or outcome. Each feature declares its own.

## Public API

### `@dotli/metrics`

| Export                                                         | What it does                                        |
| -------------------------------------------------------------- | --------------------------------------------------- |
| `m`, `SpanHandle`, `SpanValue`                                 | Counts, distributions, gauges, timers, breadcrumbs. |
| `spans`                                                        | Shared metric names, imported as `spans as S`.      |
| `defineCount`, `CountMetric`, `CountAttributes`                | A feature's count and its outcome set.              |
| `CountSink`, `countMetric`                                     | A count taken as a param, and its default.          |
| `createReporter`, `Reporter`, `DefectParams`, `ExpectedParams` | A feature's reporter, built once with its flow.     |
| `bindCaptureSink`, `CaptureContext`, `CaptureSink`             | The capture sink a context binds once.              |
| `initSentry`, `installGlobalErrorHandlers`                     | Sentry setup.                                       |
| `flushTelemetry`                                               | Flushes before a context closes. Never rejects.     |
| `getResolutionId`, `setResolutionId`                           | Ties a resolution's events together.                |

### `@dotli/metrics/testing`

Never imported by shipped code.

| Export                                                     | What it does                            |
| ---------------------------------------------------------- | --------------------------------------- |
| `bindRecordingSentry`, `RecordingSentry`, `RecordedMetric` | A recording Sentry to bind and restore. |
| `recordReports`, `RecordedReport`, `RecordedReports`       | Records each reported failure, by step. |

### `@dotli/metrics/testing/setup`

Import it in a test runner's setup to record Sentry for the whole run.

## Design

- **Compile-time switch:** `VITE_METRICS` picks the live `m` or an inert one of the same type. Callers never branch.
- **SDK isolation:** only the Sentry modules import `@sentry/browser`, behind the same flag. A build without metrics
  drops the SDK.
- **Sinks:** capture forwards to a bound sink. Tests bind their own instead of mocking the package.
- **Fingerprint:** a capture's flow and snake_case `step` form the issue fingerprint.
- **Source tag:** Sentry setup tags each event with its `source` (`host`, `protocol`, `worker`, `sandbox`).
