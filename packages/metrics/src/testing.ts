// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Test helpers for observability assertions.
//
// Every failing-path test should assert that the failure was observable:
// either a metric with a matching `outcome` was emitted, or a Sentry
// breadcrumb was recorded. Without these assertions, a silent swallow
// regression passes every test as long as the happy path still works.
//
// Usage:
//
//   import { installMetricsHarness, expectMetric, expectSentryBreadcrumb }
//     from "@dotli/metrics/testing";
//
//   const harness = installMetricsHarness();
//   // ... run code under test ...
//   expectMetric(harness, "smoldot.presync", { outcome: "error" });

import { expect } from "vitest";

export interface RecordedMetric {
  kind: "count" | "distribution" | "gauge";
  name: string;
  value: number;
  attributes: Record<string, string>;
}

export interface RecordedBreadcrumb {
  category: string;
  message: string;
  level?: string;
  data?: Record<string, unknown>;
}

export interface MetricsHarness {
  metrics: RecordedMetric[];
  breadcrumbs: RecordedBreadcrumb[];
  tags: Map<string, string>;
  /** Tear down the harness and clear globalThis.__SENTRY_HUB__. */
  restore(): void;
}

/**
 * Install a stub Sentry hub on `globalThis.__SENTRY_HUB__` and a
 * matching `m.bind()` recipient so every metric call emitted during
 * the test is captured in `harness.metrics` / `harness.breadcrumbs`.
 *
 * Call once per test, then call `harness.restore()` in `afterEach`. The
 * harness is re-entrant safe: multiple concurrent tests get their own
 * recorder (they share the module-level metrics bind, but each install
 * replaces the prior one so the last test wins).
 */
export function installMetricsHarness(): MetricsHarness {
  const metrics: RecordedMetric[] = [];
  const breadcrumbs: RecordedBreadcrumb[] = [];
  const tags = new Map<string, string>();

  const stub = {
    startSpan: <T>(
      _opts: { op: string; name: string },
      fn: (span: { setAttribute: (key: string, value: string) => void }) => T,
    ): T =>
      fn({
        setAttribute: (key: string, value: string): void => {
          tags.set(key, value);
        },
      }),
    setMeasurement: (): void => {
      /* no-op */
    },
    metrics: {
      count: (
        name: string,
        value = 1,
        opts?: { attributes?: Record<string, string> },
      ): void => {
        metrics.push({
          kind: "count",
          name,
          value,
          attributes: opts?.attributes ?? {},
        });
      },
      distribution: (
        name: string,
        value: number,
        opts?: { attributes?: Record<string, string> },
      ): void => {
        metrics.push({
          kind: "distribution",
          name,
          value,
          attributes: opts?.attributes ?? {},
        });
      },
      gauge: (
        name: string,
        value: number,
        opts?: { attributes?: Record<string, string> },
      ): void => {
        metrics.push({
          kind: "gauge",
          name,
          value,
          attributes: opts?.attributes ?? {},
        });
      },
    },
    setTag: (key: string, value: string): void => {
      tags.set(key, value);
    },
    addBreadcrumb: (b: RecordedBreadcrumb): void => {
      breadcrumbs.push(b);
    },
  };

  (globalThis as Record<string, unknown>).__SENTRY_HUB__ = stub;

  return {
    metrics,
    breadcrumbs,
    tags,
    restore(): void {
      delete (globalThis as Record<string, unknown>).__SENTRY_HUB__;
    },
  };
}

/**
 * Assert that a metric with the given name + attribute subset was
 * emitted at least once. Attribute matching is strict-equal per key:
 * extras on the actual metric are allowed; missing keys fail the
 * assertion.
 */
export function expectMetric(
  harness: MetricsHarness,
  name: string,
  attributes: Partial<Record<string, string>> = {},
): void {
  // Metrics are emitted with the `"dotli."` prefix. Callers pass the
  // suffix for readability (matches the `S.*` constants in spans.ts).
  const fullName = name.startsWith("dotli.") ? name : `dotli.${name}`;
  const match = harness.metrics.find(
    (m) =>
      m.name === fullName &&
      Object.entries(attributes).every(
        ([k, v]) => v === undefined || m.attributes[k] === v,
      ),
  );
  if (match === undefined) {
    const available = harness.metrics.map(
      (m) => `${m.name} ${JSON.stringify(m.attributes)}`,
    );
    expect(
      match,
      `expected metric ${fullName} with ${JSON.stringify(attributes)}; captured: ${available.join(" | ")}`,
    ).toBeDefined();
  }
}

/**
 * Assert that a Sentry breadcrumb matching `predicate` was recorded.
 *
 * The predicate form keeps the helper flexible: tests can match on
 * category, level, message substring, or any subset of `data` fields.
 */
export function expectSentryBreadcrumb(
  harness: MetricsHarness,
  predicate: (b: RecordedBreadcrumb) => boolean,
): void {
  const match = harness.breadcrumbs.find(predicate);
  if (match === undefined) {
    const available = harness.breadcrumbs.map(
      (b) => `${b.category}/${b.level ?? "info"}: ${b.message}`,
    );
    expect(
      match,
      `expected a matching Sentry breadcrumb; captured: ${available.join(" | ")}`,
    ).toBeDefined();
  }
}
