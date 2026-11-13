// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { m } from '@dotli/metrics';
import {
  createFakePage,
  type FakePage,
  createManualTimers,
  createMemoryStorage,
  resetAllStoresForTests,
} from '@dotli/shared/testing';
import { createContinuation } from './createContinuation.js';
import { startResolutionTrace, type ResolutionTrace, type ResolutionTraceParams } from './startResolutionTrace.js';
import { loadingState } from './state/loadingState.js';

type Sentry = Parameters<typeof m.bind>[0];

type SentrySpan = ReturnType<Sentry['startInactiveSpan']>;

/** Records the span tree instead of sending it. Metrics are on in specs, so the real tree is built. */
type RecordedSpan = {
  name: string;
  parent: RecordedSpan | null;
  attributes: Record<string, unknown>;
  ended: boolean;
  startTime?: number | undefined;
  endTime?: number | undefined;
};

/** The page a trace runs in, and the span tree it recorded, until the case ends. */
type TracePage = {
  /** Where the visitor leaves from. */
  page: FakePage;
  /** The tab's session storage. */
  session: Storage;
  /** The spans recorded so far, oldest first. */
  spans: readonly RecordedSpan[];
  /** Opens a trace on this page. */
  startTrace: (params: Omit<ResolutionTraceParams, 'page'>) => ResolutionTrace;
  /** Returns the recorded span `dotli.<name>`, or undefined when there is none. */
  findSpan: (name: string) => RecordedSpan | undefined;
  /** Returns the names of every recorded span, oldest first. */
  listSpanNames: () => string[];
};

const ATTEMPT = { journeyId: 'journey-1', attemptNumber: 2, entry: 'reload_button' } as const;

const TRACE_PARAMS = {
  domain: 'host-playground.dot',
  network: 'paseo-next-v2',
  backend: 'smoldot-direct',
  attempt: ATTEMPT,
  startedAt: performance.now(),
};

describe('A resolution is traced as one unit', () => {
  it('As a maintainer, I search for a page load and get the whole of it with what was asked for', () => {
    // Given
    const { startTrace, findSpan } = setupTracePage();

    // When
    startTrace(TRACE_PARAMS);
    const root = findSpan('resolution');

    // Then
    expect(root).toBeDefined();
    expect(root?.parent).toBeNull();
    expect(root?.attributes).toMatchObject({
      domain: 'host-playground.dot',
      network: 'paseo-next-v2',
      backend: 'smoldot-direct',
    });
  });

  it('As a maintainer, I watch a chain start and it appears in the trace only then', () => {
    // Given
    const { startTrace, findSpan, listSpanNames } = setupTracePage();
    const trace = startTrace(TRACE_PARAMS);
    const namesBefore = listSpanNames();

    // When
    trace.recordChainSync({ chain: 'bulletin', kind: 'connecting' });

    // Then
    expect(namesBefore).not.toContain('dotli.chain.bulletin');
    expect(findSpan('chain.bulletin')?.parent).toBe(findSpan('resolution'));
  });

  it('As a maintainer, I read the trace and see every phase a chain went through under that chain', () => {
    // Given
    const { startTrace, findSpan } = setupTracePage();
    const trace = startTrace(TRACE_PARAMS);

    // When
    trace.recordChainSync({ chain: 'relay', kind: 'connecting' });
    trace.recordChainSync({
      chain: 'relay',
      kind: 'warpSyncProgress',
      at: 10,
      target: 20,
    });
    trace.recordChainSync({ chain: 'relay', kind: 'bootstrapComplete' });

    // Then
    expect(findSpan('chain.relay.connecting')?.parent).toBe(findSpan('chain.relay'));
    expect(findSpan('chain.relay.syncing')?.parent).toBe(findSpan('chain.relay'));
    expect(findSpan('chain.relay.ready')?.parent).toBe(findSpan('chain.relay'));
  });

  it('As a maintainer, I read the trace and see the time a chain spent connecting as a closed interval', () => {
    // Given
    const { startTrace, findSpan } = setupTracePage();
    const trace = startTrace(TRACE_PARAMS);

    // When
    trace.recordChainSync({ chain: 'relay', kind: 'connecting' });
    trace.recordChainSync({ chain: 'relay', kind: 'bootstrapComplete' });

    // Then
    expect(findSpan('chain.relay.connecting')?.ended).toBe(true);
  });

  it('As a maintainer, I read the trace and see each phase of a chain start where the one before it ended', () => {
    // Given a clock that moves on every reading
    const { startTrace, findSpan } = setupTracePage();
    let ticks = 0;
    const trace = startTrace({ ...TRACE_PARAMS, startedAt: 0, timers: { now: () => 0 }, now: () => ticks++ });

    // When
    trace.recordChainSync({ chain: 'relay', kind: 'connecting' });
    trace.recordChainSync({ chain: 'relay', kind: 'bootstrapComplete' });

    // Then
    expect(findSpan('chain.relay.ready')?.startTime).toBe(findSpan('chain.relay.connecting')?.endTime);
  });

  it("As a maintainer, I read the name's resolution and its span lasts as long as the duration it reports", () => {
    // Given a clock that moves on every reading, and a trace that starts at 0
    const { startTrace, findSpan } = setupTracePage();
    let ticks = 0;
    const trace = startTrace({ ...TRACE_PARAMS, startedAt: 0, timers: { now: () => 0 }, now: () => ticks++ });

    // When
    trace.recordNameResolved('bafy123');
    const span = findSpan('name_resolution');

    // Then
    expect(span?.startTime).toBe(0);
    expect(span?.endTime).toBe(span?.attributes['duration_ms']);
  });

  it("As an operator, I read Asset Hub's spans and summary and they keep the name asset-hub that dashboards read", () => {
    // Given
    const { startTrace, findSpan, listSpanNames } = setupTracePage();
    const trace = startTrace(TRACE_PARAMS);

    // When
    trace.recordChainSync({ chain: 'assethub', kind: 'connecting' });
    trace.recordChainSync({ chain: 'assethub', kind: 'bootstrapComplete' });
    trace.finish('rendered');

    // Then
    expect(listSpanNames()).toContain('dotli.chain.asset-hub');
    expect(listSpanNames()).not.toContain('dotli.chain.assethub');
    expect(findSpan('resolution')?.attributes).toHaveProperty('chain.asset-hub.ready_ms');
    expect(findSpan('chain.asset-hub')?.attributes).toMatchObject({ chain: 'asset-hub' });
  });

  it('As a maintainer, I read the trace and see how far the relay had to catch up', () => {
    // Given
    const { startTrace, findSpan } = setupTracePage();
    const trace = startTrace(TRACE_PARAMS);

    // When
    trace.recordChainSync({
      chain: 'relay',
      kind: 'warpSyncProgress',
      at: 974196,
      target: 1006056,
    });
    trace.recordChainSync({
      chain: 'relay',
      kind: 'warpSyncProgress',
      at: 1006053,
      target: 1006056,
    });
    trace.finish('rendered');

    // Then
    expect(findSpan('chain.relay')?.attributes).toMatchObject({
      warp_from: 974196,
      warp_at: 1006053,
      warp_target: 1006056,
      warp_blocks: 31857,
    });
  });

  it('As a maintainer, I read the trace and see whether a chain started warm and who it was talking to', () => {
    // Given
    const { startTrace, findSpan } = setupTracePage();
    const trace = startTrace(TRACE_PARAMS);
    trace.recordChainSync({ chain: 'relay', kind: 'connecting' });

    // When
    trace.recordChainDetail({
      chain: 'relay',
      dbCache: 'miss',
      peers: [
        { peerId: '12D3KooWA', roles: 'AUTHORITY', bestNumber: 1006056 },
        { peerId: '12D3KooWB', roles: 'FULL', bestNumber: 1006056 },
      ],
    });
    trace.finish('rendered');

    // Then
    expect(findSpan('chain.relay')?.attributes).toMatchObject({
      db_cache: 'miss',
      peers_authority: 1,
    });
  });
});

describe('A resolution reports how it ended', () => {
  it('As a maintainer, I read a load that reached the app and see its outcome and duration', async () => {
    // Given a load that reaches the app 2.5s after the page started
    const { startTrace, findSpan } = setupTracePage();
    const timers = createManualTimers();
    const trace = startTrace({ ...TRACE_PARAMS, startedAt: timers.now(), timers, now: timers.now });

    // When
    trace.recordNameResolved('bafy123');
    await timers.advance(2_500);
    trace.finish('rendered');

    // Then
    expect(findSpan('resolution')?.attributes).toMatchObject({
      outcome: 'rendered',
      cid: 'bafy123',
      total_ms: 2_500,
    });
    expect(findSpan('resolution')?.ended).toBe(true);
  });

  it('As a maintainer, I read a load the visitor walked away from and it still reached me', () => {
    // Given
    const { page, startTrace, findSpan } = setupTracePage();
    startTrace(TRACE_PARAMS);

    // When
    page.hide(false);

    // Then
    expect(findSpan('resolution')?.attributes).toMatchObject({ outcome: 'abandoned', exit: 'unload' });
    expect(findSpan('resolution')?.ended).toBe(true);
  });

  it('As a maintainer, I read a failed load and see the reason it failed', () => {
    // Given
    const { startTrace, findSpan } = setupTracePage();
    const trace = startTrace(TRACE_PARAMS);

    // When
    trace.finish('error', { reason: 'Sync to Asset Hub timed out', errorKind: 'hub-sync-timeout' });

    // Then
    expect(findSpan('resolution')?.attributes).toMatchObject({
      outcome: 'error',
      failure_reason: 'Sync to Asset Hub timed out',
      error_kind: 'hub-sync-timeout',
    });
  });

  it('As a maintainer, I read a finished load and reports that arrive after it change nothing', () => {
    // Given
    const { startTrace, spans } = setupTracePage();
    const trace = startTrace(TRACE_PARAMS);
    trace.finish('rendered');
    const atFinish = structuredClone(spans);

    // When
    trace.recordChainSync({ chain: 'relay', kind: 'connecting' });
    trace.recordChainDetail({ chain: 'bulletin', dbCache: 'hit' });
    trace.recordContent(10, 20);
    trace.recordNameResolved('bafy123');

    // Then
    expect(spans).toEqual(atFinish);
  });

  it('As a maintainer, I read a load with a chain that never finished and the trace is closed anyway', () => {
    // Given
    const { startTrace, spans } = setupTracePage();
    const trace = startTrace(TRACE_PARAMS);
    trace.recordChainSync({ chain: 'assethub', kind: 'connecting' });

    // When
    trace.finish('abandoned');

    // Then
    expect(spans.every(s => s.ended)).toBe(true);
  });

  it('As a maintainer, I read the bar of a load and see the progress the visitor actually saw, not a forced 100%', () => {
    // Given the bar at 62%
    const { startTrace, findSpan } = setupTracePage();
    loadingState.update({ progress: 62 });
    const trace = startTrace(TRACE_PARAMS);
    trace.recordBytes(1_000);

    // When the load completes and the bar is forced full
    loadingState.update({ progress: 100 });
    trace.finish('rendered');

    // Then
    expect(findSpan('resolution')?.attributes['bar_at_render']).toBe(62);
  });

  it('As a maintainer, I read the trace and see how much the load downloaded', () => {
    // Given
    const { startTrace, findSpan } = setupTracePage();
    const trace = startTrace(TRACE_PARAMS);

    // When
    trace.recordBytes(1_000_000);
    trace.recordBytes(21_266_125);
    trace.finish('rendered');

    // Then
    expect(findSpan('resolution')?.attributes['bytes_total']).toBe(21_266_125);
  });

  it('As a maintainer, I read a content load that failed and see the sandbox step it stopped at', () => {
    // Given
    const { startTrace, findSpan } = setupTracePage();
    const trace = startTrace(TRACE_PARAMS);
    trace.recordStep('content');

    // When
    trace.finish('content_error', { failedStep: 'content_fetch' });

    // Then
    expect(findSpan('resolution')?.attributes).toMatchObject({
      outcome: 'content_error',
      loading_phase: 'content',
      failed_step: 'content_fetch',
    });
  });

  it('As a maintainer, I read a load and see whether the visitor had seen a slow-load warning', () => {
    // Given
    const { startTrace, findSpan } = setupTracePage();
    const trace = startTrace(TRACE_PARAMS);

    // When
    trace.markWarningShown();
    trace.finish('abandoned');

    // Then
    expect(findSpan('resolution')?.attributes).toMatchObject({ warning_shown: true });
  });
});

describe('A resolution is one attempt of a journey', () => {
  it('As a maintainer, I read any attempt and see its journey, its number and how it began', () => {
    // Given
    const { startTrace, findSpan } = setupTracePage();

    // When
    startTrace(TRACE_PARAMS);

    // Then
    expect(findSpan('resolution')?.attributes).toMatchObject({
      journey_id: 'journey-1',
      attempt_number: 2,
      entry: 'reload_button',
    });
  });

  it('As a maintainer, I read the trace and see it start when the page load did, not when resolution began', () => {
    // Given a page load that started 1.5s before the trace opened
    const { startTrace, findSpan } = setupTracePage();
    const timers = createManualTimers();
    const startedAt = timers.now() - 1_500;

    // When
    startTrace({ ...TRACE_PARAMS, startedAt, timers, now: timers.now });

    // Then
    expect(findSpan('resolution')?.startTime).toBe(timers.now() - 1_500);
  });

  it('As a maintainer, I read a page kept in the back/forward cache and it is told apart from one that unloaded', () => {
    // Given
    const { page, startTrace, findSpan } = setupTracePage();
    startTrace(TRACE_PARAMS);

    // When
    page.hide(true);

    // Then
    expect(findSpan('resolution')?.attributes).toMatchObject({ outcome: 'abandoned', exit: 'bfcache' });
  });

  it('As a maintainer, I read a load the visitor left by reloading from the error page and it says so', () => {
    // Given
    const { page, session, startTrace, findSpan } = setupTracePage();
    startTrace(TRACE_PARAMS);
    createContinuation({ store: session }).mark('reload_button');

    // When
    page.hide(false);

    // Then
    expect(findSpan('resolution')?.attributes).toMatchObject({ outcome: 'abandoned', exit: 'reload_button' });
  });

  it('As a maintainer, I end the trace and it stops listening for the visitor leaving, and ending or disposing it again changes nothing', () => {
    // Given
    const { page, startTrace, findSpan } = setupTracePage();
    const trace = startTrace(TRACE_PARAMS);

    // When
    trace.finish('rendered');
    trace.finish('error');
    trace.dispose();
    page.hide(false);

    // Then
    expect(findSpan('resolution')?.attributes['outcome']).toBe('rendered');
    expect(findSpan('resolution')?.attributes['exit']).toBeUndefined();
  });

  it('As a maintainer, I dispose the trace and the visitor leaving after ends nothing', () => {
    // Given
    const { page, startTrace, findSpan } = setupTracePage();
    const trace = startTrace(TRACE_PARAMS);

    // When the trace is disposed, and the visitor leaves
    trace.dispose();
    page.hide(false);

    // Then
    expect(findSpan('resolution')?.attributes['outcome']).toBeUndefined();
  });
});

/** Builds a fresh page and binds a Sentry that records the span tree, until the case ends. */
function setupTracePage(): TracePage {
  const { sentry, spans } = createRecordingSentry();
  onTestFinished(m.bind(sentry));
  const page = createFakePage();
  const session = createMemoryStorage();
  resetAllStoresForTests();
  return {
    page,
    session,
    spans,
    startTrace(params) {
      return startResolutionTrace({
        ...params,
        page: {
          lifecycle: page.window,
          isVisible: () => true,
          readProgress: () => loadingState.get().progress,
          peekContinuation: () => createContinuation({ store: session }).peek(),
        },
      });
    },
    findSpan: name => spans.find(s => s.name === `dotli.${name}`),
    listSpanNames: () => spans.map(s => s.name),
  };
}

/** Returns a Sentry that records each span it starts, with the span it was started under, and what it recorded. */
function createRecordingSentry(): { sentry: Sentry; spans: readonly RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const recordOf = new Map<unknown, RecordedSpan>();
  const sentry: Sentry = {
    startInactiveSpan(options) {
      const record: RecordedSpan = {
        name: options.name,
        parent: recordOf.get(options.parentSpan) ?? null,
        attributes: { ...options.attributes },
        ended: false,
        startTime: options.startTime,
      };
      spans.push(record);
      const span: SentrySpan = {
        setAttributes(attributes) {
          Object.assign(record.attributes, attributes);
        },
        end(endTime) {
          record.ended = true;
          record.endTime = endTime;
        },
      };
      recordOf.set(span, record);
      return span;
    },
    startSpan(_options, run) {
      return run(undefined);
    },
    setMeasurement() {
      /* unused by the trace */
    },
    metrics: { count() {}, distribution() {}, gauge() {} },
    setTag() {},
    addBreadcrumb() {},
  };
  return { sentry, spans };
}
