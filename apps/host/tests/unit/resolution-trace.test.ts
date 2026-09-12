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
  it("As an engineer, the load opens one root span carrying what was asked for", () => {
    // Given / When
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

  it("As an engineer, a chain gets its span only once it is first heard from", () => {
    // Given Bulletin is created late, once the content phase starts, so a span
    // opened at boot would claim it was idle rather than absent.
    const trace = startResolutionTrace(OPTS);

    // Then
    expect(names()).not.toContain("dotli.chain.bulletin");

    // When
    trace.chainSync({ chain: "bulletin", syncKind: "connecting" });

    // Then
    expect(span("chain.bulletin")?.parent).toBe(span("resolution"));
  });

  it("As an engineer, each chain phase becomes its own span under that chain", () => {
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

  it("As an engineer, a phase span closes when the next phase opens", () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // When
    trace.chainSync({ chain: "relay", syncKind: "connecting" });
    trace.chainSync({ chain: "relay", syncKind: "bootstrapComplete" });

    // Then the time spent connecting is a closed interval, not an open one.
    expect(span("chain.relay.connecting")?.ended).toBe(true);
  });

  it("As an engineer, the warp distance is reported against the chain", () => {
    // Given a chain can enter `syncing` more than once, so these belong on the
    // chain rather than split across however many syncing spans it opened.
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

  it("As an engineer, a chain's cache result and peers reach its span", () => {
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
  it("As an engineer, a rendered load records the outcome and its duration", () => {
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

  it("As an engineer, a load nobody waited for is still reported", () => {
    // Given a slow link can sit on the loading screen forever without ever
    // reaching an error page, so the failure is invisible unless it is flushed.
    const trace = startResolutionTrace(OPTS);

    // When
    trace.finish("abandoned");

    // Then
    expect(span("resolution")?.attributes).toMatchObject({
      outcome: "abandoned",
    });
    expect(span("resolution")?.ended).toBe(true);
  });

  it("As an engineer, a failure keeps its reason", () => {
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

  it("As an engineer, the first outcome wins so a later one cannot rewrite history", () => {
    // Given a page that renders and is then navigated away from fires both.
    const trace = startResolutionTrace(OPTS);

    // When
    trace.finish("rendered");
    trace.finish("abandoned");

    // Then
    expect(span("resolution")?.attributes).toMatchObject({
      outcome: "rendered",
    });
  });

  it("As an engineer, every open chain span is closed when the trace ends", () => {
    // Given a chain that never reached ready.
    const trace = startResolutionTrace(OPTS);
    trace.chainSync({ chain: "asset-hub", syncKind: "connecting" });

    // When
    trace.finish("abandoned");

    // Then nothing is left open to hang the transaction.
    expect(spans.every((s) => s.ended)).toBe(true);
  });

  it("As an engineer, the bar is reported as it stood during the load", () => {
    // Given the loading screen forces the bar to 100% and removes it before
    // `finish` runs, so reading the DOM at the end reports 100% every time and
    // the drift this measurement exists to catch would be invisible.
    document.body.innerHTML =
      '<div class="loading-progress-fill" style="width: 62%"></div>';
    const trace = startResolutionTrace(OPTS);
    trace.bytes(1_000);

    // When the screen is torn down before the trace closes
    document.body.innerHTML = "";
    trace.finish("rendered");

    // Then
    expect(span("resolution")?.attributes.bar_at_render).toBe(62);
  });

  it("As an engineer, the bytes it moved are on the root", () => {
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
