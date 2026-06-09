// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from "vitest";
import { m } from "../src/metrics";

describe("metrics (disabled)", () => {
  it("has enabled = false when VITE_METRICS is not 'true'", () => {
    expect(m.enabled).toBe(false);
  });

  it("span runs the function without instrumentation", () => {
    const fn = vi.fn(() => 42);
    const result = m.span("test.span", fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("span runs async functions without instrumentation", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await m.span("test.async", fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("timer returns a stop function that returns 0", () => {
    const stop = m.timer("test.timer");
    expect(typeof stop).toBe("function");
    expect(stop()).toBe(0);
  });

  it("count, measure, distribution, gauge, tag, breadcrumb are no-ops", () => {
    // Should not throw
    m.count("test.count");
    m.measure("test.measure", 100);
    m.distribution("test.dist", 50);
    m.gauge("test.gauge", 1);
    m.tag("key", "value");
    m.breadcrumb("test message");
  });

  it("bind accepts a sentry-like object without error", () => {
    const fake = {
      startSpan: vi.fn(),
      setMeasurement: vi.fn(),
      metrics: {
        count: vi.fn(),
        distribution: vi.fn(),
        gauge: vi.fn(),
      },
      setTag: vi.fn(),
      addBreadcrumb: vi.fn(),
    };
    m.bind(fake);
    // Still disabled: bind doesn't enable metrics
    m.count("test");
    expect(fake.metrics.count).not.toHaveBeenCalled();
  });
});
