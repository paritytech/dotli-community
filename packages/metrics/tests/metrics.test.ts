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

describe("resolution id", () => {
  it("As the protocol client, I read back the id the host minted", async () => {
    // Given
    const { setResolutionId, getResolutionId } = await import("../src/metrics");

    // When
    setResolutionId("f1e2d3c4-b5a6-4778-8899-aabbccddeeff");

    // Then the host can thread it onto the iframe URLs it builds.
    expect(getResolutionId()).toBe("f1e2d3c4-b5a6-4778-8899-aabbccddeeff");
  });

  it("As a realm booting before the host mints one, I see no id rather than a fabricated one", async () => {
    // Given a fresh module, as a realm gets on boot.
    vi.resetModules();
    const { getResolutionId } = await import("../src/metrics");

    // Then
    expect(getResolutionId()).toBeNull();
  });

  it("As a metrics-stripped build, I still carry the id so the URLs match", async () => {
    // Given the no-op twin that replaces the real module when VITE_METRICS
    // is unset. It drops the Sentry tagging but must not drop propagation,
    // or the sandbox and protocol URLs would differ between builds.
    vi.resetModules();
    const noop = await import("../src/metrics.noop");

    // When
    noop.setResolutionId("boot-1234-abcdef");

    // Then
    expect(noop.getResolutionId()).toBe("boot-1234-abcdef");
  });
});
