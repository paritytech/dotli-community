// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from "vitest";
import { m } from "@dotli/metrics/metrics";
import { startResolutionTrace } from "../../src/resolution-trace";

/**
 * A Sentry stand-in that records the span tree instead of sending it.
 *
 * The tests assert what a resolution actually produces, so a no-op metrics
 * build would prove nothing: `vitest.config.ts` turns metrics on for this
 * suite and binds this in their place.
 */
interface RecordedSpan {
  name: string;
  parent: RecordedSpan | null;
  attributes: Record<string, unknown>;
  ended: boolean;
  startTime?: number;
  endTime?: number;
}

function fakeSentry(): { spans: RecordedSpan[]; sentry: unknown } {
  const spans: RecordedSpan[] = [];
  const sentry = {
    startInactiveSpan(opts: {
      name: string;
      startTime?: number;
      parentSpan?: unknown;
      attributes?: Record<string, unknown>;
    }) {
      const rec: RecordedSpan = {
        name: opts.name,
        parent:
          (opts.parentSpan as { __rec?: RecordedSpan } | undefined)?.__rec ??
          null,
        attributes: { ...opts.attributes },
        ended: false,
        startTime: opts.startTime,
      };
      spans.push(rec);
      return {
        setAttributes(attrs: Record<string, unknown>) {
          Object.assign(rec.attributes, attrs);
        },
        end(endTime?: number) {
          rec.ended = true;
          rec.endTime = endTime;
        },
        __rec: rec,
      };
    },
    startSpan<T>(_o: unknown, fn: (s: undefined) => T): T {
      return fn(undefined);
    },
    setMeasurement() {
      /* unused by the trace */
    },
    metrics: { count() {}, distribution() {}, gauge() {} },
    setTag() {},
    addBreadcrumb() {},
  };
  return { spans, sentry };
}

let spans: RecordedSpan[];

/** The span named `dotli.<name>`, or undefined. */
function span(name: string): RecordedSpan | undefined {
  return spans.find((s) => s.name === `dotli.${name}`);
}

function names(): string[] {
  return spans.map((s) => s.name);
}

beforeEach(() => {
  const fake = fakeSentry();
  spans = fake.spans;
  m.bind(fake.sentry as Parameters<typeof m.bind>[0]);
});

const OPTS = {
  domain: "host-playground.dot",
  network: "paseo-next-v2",
  backend: "smoldot-direct",
};

describe("A resolution is traced as one unit", () => {
  it("As a maintainer, one search returns the whole page load with what was asked for", () => {
    // Given
    startResolutionTrace(OPTS);

    // Then
    const root = span("resolution");
    expect(root).toBeDefined();
    expect(root?.parent).toBeNull();
    expect(root?.attributes).toMatchObject({
      domain: "host-playground.dot",
      network: "paseo-next-v2",
      backend: "smoldot-direct",
    });
  });

  it("As a maintainer, a chain appears in the trace only once it has actually started", () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // Then
    expect(names()).not.toContain("dotli.chain.bulletin");

    // When
    trace.chainSync({ chain: "bulletin", syncKind: "connecting" });

    // Then
    expect(span("chain.bulletin")?.parent).toBe(span("resolution"));
  });

  it("As a maintainer, I can read how long each chain spent in every phase", () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // When
    trace.chainSync({ chain: "relay", syncKind: "connecting" });
    trace.chainSync({
      chain: "relay",
      syncKind: "warpSyncProgress",
      at: 10,
      target: 20,
    });
    trace.chainSync({ chain: "relay", syncKind: "bootstrapComplete" });

    // Then
    const chain = span("chain.relay");
    for (const phase of ["connecting", "syncing", "ready"]) {
      expect(span(`chain.relay.${phase}`)?.parent).toBe(chain);
    }
  });

  it("As a maintainer, the time a chain spent connecting is a closed interval", () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // When
    trace.chainSync({ chain: "relay", syncKind: "connecting" });
    trace.chainSync({ chain: "relay", syncKind: "bootstrapComplete" });

    // Then
    expect(span("chain.relay.connecting")?.ended).toBe(true);
  });

  it("As a maintainer, I can read how far the relay had to catch up", () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // When
    trace.chainSync({
      chain: "relay",
      syncKind: "warpSyncProgress",
      at: 974196,
      target: 1006056,
    });
    trace.chainSync({
      chain: "relay",
      syncKind: "warpSyncProgress",
      at: 1006053,
      target: 1006056,
    });
    trace.finish("rendered");

    // Then
    expect(span("chain.relay")?.attributes).toMatchObject({
      warp_from: 974196,
      warp_at: 1006053,
      warp_target: 1006056,
      warp_blocks: 31857,
    });
  });

  it("As a maintainer, I can read whether a chain started warm and who it was talking to", () => {
    // Given
    const trace = startResolutionTrace(OPTS);
    trace.chainSync({ chain: "relay", syncKind: "connecting" });

    // When
    trace.chainDetail({
      chain: "relay",
      dbCache: "miss",
      peers: [
        { peerId: "12D3KooWA", roles: "AUTHORITY", bestNumber: 1006056 },
        { peerId: "12D3KooWB", roles: "FULL", bestNumber: 1006056 },
      ],
    });
    trace.finish("rendered");

    // Then
    expect(span("chain.relay")?.attributes).toMatchObject({
      db_cache: "miss",
      peers_authority: 1,
    });
  });
});

describe("A resolution reports how it ended", () => {
  it("As a maintainer, a rendered load reports its outcome and duration", () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // When
    trace.nameResolved("bafy123");
    trace.finish("rendered");

    // Then
    const root = span("resolution");
    expect(root?.attributes).toMatchObject({
      outcome: "rendered",
      cid: "bafy123",
    });
    expect(root?.ended).toBe(true);
  });

  it("As a maintainer, a load the visitor walked away from still reaches me", () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // When
    trace.finish("abandoned");

    // Then
    expect(span("resolution")?.attributes).toMatchObject({
      outcome: "abandoned",
    });
    expect(span("resolution")?.ended).toBe(true);
  });

  it("As a maintainer, a failed load keeps the reason it failed", () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // When
    trace.finish("error", "no contenthash");

    // Then
    expect(span("resolution")?.attributes).toMatchObject({
      outcome: "error",
      failure_reason: "no contenthash",
    });
  });

  it("As a maintainer, a navigation after success cannot rewrite the outcome", () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // When
    trace.finish("rendered");
    trace.finish("abandoned");

    // Then
    expect(span("resolution")?.attributes).toMatchObject({
      outcome: "rendered",
    });
  });

  it("As a maintainer, a chain that never finished cannot hold the trace open", () => {
    // Given
    const trace = startResolutionTrace(OPTS);
    trace.chainSync({ chain: "asset-hub", syncKind: "connecting" });

    // When
    trace.finish("abandoned");

    // Then
    expect(spans.every((s) => s.ended)).toBe(true);
  });

  it("As a maintainer, I see the progress the visitor actually saw, not a forced 100%", () => {
    // Given
    document.body.innerHTML =
      '<div class="loading-progress-fill" style="width: 62%"></div>';
    const trace = startResolutionTrace(OPTS);
    trace.bytes(1_000);

    // When
    document.body.innerHTML = "";
    trace.finish("rendered");

    // Then
    expect(span("resolution")?.attributes.bar_at_render).toBe(62);
  });

  it("As a maintainer, I can read how much the load downloaded", () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // When
    trace.bytes(1_000_000);
    trace.bytes(21_266_125);
    trace.finish("rendered");

    // Then
    expect(span("resolution")?.attributes.bytes_total).toBe(21_266_125);
  });
});
