// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import { m } from '@dotli/metrics';
import { markContinuation } from '@dotli/shared';
import { updateLoading } from '@dotli/ui';
import { startResolutionTrace } from '../../src/resolution-trace.js';

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
  startTime?: number | undefined;
  endTime?: number | undefined;
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
        parent: (opts.parentSpan as { __rec?: RecordedSpan } | undefined)?.__rec ?? null,
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
  return spans.find(s => s.name === `dotli.${name}`);
}

/** happy-dom drops `persisted` from the PageTransitionEvent init, so it is set by hand. */
function pagehide(persisted: boolean): Event {
  return Object.assign(new Event('pagehide'), { persisted });
}

function names(): string[] {
  return spans.map(s => s.name);
}

beforeEach(() => {
  const fake = fakeSentry();
  spans = fake.spans;
  m.bind(fake.sentry as Parameters<typeof m.bind>[0]);
});

const ATTEMPT = { journeyId: 'journey-1', attemptNumber: 2, entry: 'reload_button' } as const;

const OPTS = {
  domain: 'host-playground.dot',
  network: 'paseo-next-v2',
  backend: 'smoldot-direct',
  attempt: ATTEMPT,
  startedAt: performance.now(),
};

describe('A resolution is traced as one unit', () => {
  it('As a maintainer, one search returns the whole page load with what was asked for', () => {
    // Given
    startResolutionTrace(OPTS);

    // Then
    const root = span('resolution');
    expect(root).toBeDefined();
    expect(root?.parent).toBeNull();
    expect(root?.attributes).toMatchObject({
      domain: 'host-playground.dot',
      network: 'paseo-next-v2',
      backend: 'smoldot-direct',
    });
  });

  it('As a maintainer, a chain appears in the trace only once it has actually started', () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // Then
    expect(names()).not.toContain('dotli.chain.bulletin');

    // When
    trace.chainSync({ chain: 'bulletin', syncKind: 'connecting' });

    // Then
    expect(span('chain.bulletin')?.parent).toBe(span('resolution'));
  });

  it('As a maintainer, I can read how long each chain spent in every phase', () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // When
    trace.chainSync({ chain: 'relay', syncKind: 'connecting' });
    trace.chainSync({
      chain: 'relay',
      syncKind: 'warpSyncProgress',
      at: 10,
      target: 20,
    });
    trace.chainSync({ chain: 'relay', syncKind: 'bootstrapComplete' });

    // Then
    const chain = span('chain.relay');
    for (const phase of ['connecting', 'syncing', 'ready']) {
      expect(span(`chain.relay.${phase}`)?.parent).toBe(chain);
    }
  });

  it('As a maintainer, the time a chain spent connecting is a closed interval', () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // When
    trace.chainSync({ chain: 'relay', syncKind: 'connecting' });
    trace.chainSync({ chain: 'relay', syncKind: 'bootstrapComplete' });

    // Then
    expect(span('chain.relay.connecting')?.ended).toBe(true);
  });

  it('As a maintainer, I can read how far the relay had to catch up', () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // When
    trace.chainSync({
      chain: 'relay',
      syncKind: 'warpSyncProgress',
      at: 974196,
      target: 1006056,
    });
    trace.chainSync({
      chain: 'relay',
      syncKind: 'warpSyncProgress',
      at: 1006053,
      target: 1006056,
    });
    trace.finish('rendered');

    // Then
    expect(span('chain.relay')?.attributes).toMatchObject({
      warp_from: 974196,
      warp_at: 1006053,
      warp_target: 1006056,
      warp_blocks: 31857,
    });
  });

  it('As a maintainer, I can read whether a chain started warm and who it was talking to', () => {
    // Given
    const trace = startResolutionTrace(OPTS);
    trace.chainSync({ chain: 'relay', syncKind: 'connecting' });

    // When
    trace.chainDetail({
      chain: 'relay',
      dbCache: 'miss',
      peers: [
        { peerId: '12D3KooWA', roles: 'AUTHORITY', bestNumber: 1006056 },
        { peerId: '12D3KooWB', roles: 'FULL', bestNumber: 1006056 },
      ],
    });
    trace.finish('rendered');

    // Then
    expect(span('chain.relay')?.attributes).toMatchObject({
      db_cache: 'miss',
      peers_authority: 1,
    });
  });
});

describe('A resolution reports how it ended', () => {
  it('As a maintainer, a load that reached the app reports its outcome and duration', () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // When
    trace.nameResolved('bafy123');
    trace.finish('rendered');

    // Then
    const root = span('resolution');
    expect(root?.attributes).toMatchObject({
      outcome: 'rendered',
      cid: 'bafy123',
    });
    expect(root?.ended).toBe(true);
  });

  it('As a maintainer, a load the visitor walked away from still reaches me', () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // When
    trace.finish('abandoned');

    // Then
    expect(span('resolution')?.attributes).toMatchObject({
      outcome: 'abandoned',
    });
    expect(span('resolution')?.ended).toBe(true);
  });

  it('As a maintainer, a failed load keeps the reason it failed', () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // When
    trace.finish('error', { reason: 'Sync to Asset Hub timed out', errorKind: 'hub-sync-timeout' });

    // Then
    expect(span('resolution')?.attributes).toMatchObject({
      outcome: 'error',
      failure_reason: 'Sync to Asset Hub timed out',
      error_kind: 'hub-sync-timeout',
    });
  });

  it('As a maintainer, a navigation after success cannot rewrite the outcome', () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // When
    trace.finish('rendered');
    trace.finish('abandoned');

    // Then
    expect(span('resolution')?.attributes).toMatchObject({
      outcome: 'rendered',
    });
  });

  it('As a maintainer, a chain that never finished cannot hold the trace open', () => {
    // Given
    const trace = startResolutionTrace(OPTS);
    trace.chainSync({ chain: 'asset-hub', syncKind: 'connecting' });

    // When
    trace.finish('abandoned');

    // Then
    expect(spans.every(s => s.ended)).toBe(true);
  });

  it('As a maintainer, I see the progress the visitor actually saw, not a forced 100%', () => {
    // Given the bar at 62%, with no loading screen markup on the page, as
    // before the loading island mounts or when its chunk failed
    updateLoading({ progress: 62 });
    const trace = startResolutionTrace(OPTS);
    trace.bytes(1_000);

    // When the load completes and the bar is forced full
    updateLoading({ progress: 100 });
    trace.finish('rendered');

    // Then
    expect(span('resolution')?.attributes['bar_at_render']).toBe(62);
    updateLoading({ progress: 0 });
  });

  it('As a maintainer, I can read how much the load downloaded', () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // When
    trace.bytes(1_000_000);
    trace.bytes(21_266_125);
    trace.finish('rendered');

    // Then
    expect(span('resolution')?.attributes['bytes_total']).toBe(21_266_125);
  });

  it('As a maintainer, a content load that failed names the sandbox step it stopped at', () => {
    // Given
    const trace = startResolutionTrace(OPTS);
    trace.step('content');

    // When
    trace.finish('content_error', { failedStep: 'content_fetch' });

    // Then
    expect(span('resolution')?.attributes).toMatchObject({
      outcome: 'content_error',
      loading_phase: 'content',
      failed_step: 'content_fetch',
    });
  });

  it('As a maintainer, I can tell which step a load was in when the visitor left', () => {
    // Given
    const trace = startResolutionTrace(OPTS);
    trace.step('manifest_read');

    // When
    trace.finish('abandoned');

    // Then
    expect(span('resolution')?.attributes).toMatchObject({ loading_phase: 'manifest_read' });
  });

  it('As a maintainer, I can tell whether the visitor had seen a slow-load warning', () => {
    // Given
    const trace = startResolutionTrace(OPTS);

    // When
    trace.warningShown();
    trace.finish('abandoned');

    // Then
    expect(span('resolution')?.attributes).toMatchObject({ warning_shown: true });
  });
});

describe('A resolution is one attempt of a journey', () => {
  it('As a maintainer, every attempt carries its journey, its number and how it began', () => {
    // When
    startResolutionTrace(OPTS);

    // Then
    expect(span('resolution')?.attributes).toMatchObject({
      journey_id: 'journey-1',
      attempt_number: 2,
      entry: 'reload_button',
    });
  });

  it('As a maintainer, the trace starts when the page load did, not when resolution began', () => {
    // Given a page load that started 1.5s before the trace opened
    const startedAt = performance.now() - 1_500;

    // When
    const before = Date.now();
    startResolutionTrace({ ...OPTS, startedAt });

    // Then
    expect(span('resolution')?.startTime).toBeLessThanOrEqual(before - 1_400);
  });

  it('As a maintainer, a page kept in the back/forward cache is told apart from one that unloaded', () => {
    // Given
    startResolutionTrace(OPTS);

    // When
    window.dispatchEvent(pagehide(true));

    // Then
    expect(span('resolution')?.attributes).toMatchObject({ outcome: 'abandoned', exit: 'bfcache' });
  });

  it('As a maintainer, a load the visitor left by reloading from the error page says so', () => {
    // Given
    startResolutionTrace(OPTS);
    markContinuation('reload_button');

    // When
    window.dispatchEvent(pagehide(false));

    // Then
    expect(span('resolution')?.attributes).toMatchObject({ outcome: 'abandoned', exit: 'reload_button' });
    sessionStorage.clear();
  });

  it('As a maintainer, leaving after the app loaded is not an abandonment', () => {
    // Given
    const trace = startResolutionTrace(OPTS);
    trace.finish('rendered');

    // When
    window.dispatchEvent(pagehide(false));

    // Then
    expect(span('resolution')?.attributes['outcome']).toBe('rendered');
    expect(span('resolution')?.attributes['exit']).toBeUndefined();
  });
});
