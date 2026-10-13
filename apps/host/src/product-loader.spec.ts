// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Backend } from '@dotli/config';
import { configureModeStorage } from '@dotli/config';
import { memoryModeStorage } from '@dotli/config/testing';
import { bindCaptureSink, type CaptureContext, type SpanHandle } from '@dotli/metrics';
import type { ResolvePhase } from '@dotli/resolver';
import type { CachedManifests } from '@dotli/storage';
import { bindLogSink, type LogLevel } from '@dotli/shared';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import type { LoadFailure } from './load-failure.js';
import type { NameSource } from './name-source.js';
import {
  createProductLoader,
  type ContentOutcome,
  type ProductLoader,
  type ProductLoaderDeps,
} from './product-loader.js';
import type { ResolutionTrace } from './resolution-trace.js';

const NO_MANIFESTS = { root: { kind: 'empty' as const }, app: { kind: 'empty' as const } };
const NO_CACHED_MANIFESTS: CachedManifests = { root: null, app: null };

interface Harness {
  loader: ProductLoader;
  deps: ProductLoaderDeps;
  trace: { steps: string[]; finished: { outcome: string; details: unknown }[] };
  failures: LoadFailure[];
  debug: DotliDebugEvent[];
  cacheWrites: { label: string; cid: string }[];
  reportContent: (outcome: ContentOutcome, failedStep?: string) => void;
  runIdle: () => void;
  order: string[];
  progress: { resolvePhase: ReturnType<typeof vi.fn>; nameResolved: ReturnType<typeof vi.fn> };
}

interface Options {
  backend?: Backend;
  /** Contenthashes by name. */
  published?: Record<string, string>;
  cached?: { cid: string; manifests: CachedManifests };
  skipCidCache?: boolean;
  resolveError?: Error;
  /** Settles the failure screen, which shows at once without it. */
  presentFailure?: () => Promise<void>;
}

function harness(options: Options = {}): Harness {
  const backend = options.backend ?? 'smoldot-direct';
  const steps: string[] = [];
  const finished: { outcome: string; details: unknown }[] = [];
  const failures: LoadFailure[] = [];
  const debug: DotliDebugEvent[] = [];
  const cacheWrites: { label: string; cid: string }[] = [];
  const contentCallbacks: ((outcome: ContentOutcome, failedStep: string | undefined) => void)[] = [];
  const idle: (() => void)[] = [];
  const order: string[] = [];
  const progress = { resolvePhase: vi.fn(), nameResolved: vi.fn(), contentFetch: vi.fn() };
  const span: SpanHandle = { setAttributes: () => undefined, child: () => span, end: () => undefined };
  const trace: ResolutionTrace = {
    chainSync: () => undefined,
    chainDetail: () => undefined,
    bytes: () => undefined,
    content: () => undefined,
    nameResolved: vi.fn(),
    cidCache: vi.fn(),
    step: name => {
      steps.push(name);
    },
    handedOff: vi.fn(),
    warningShown: () => undefined,
    finish: (outcome, details) => {
      finished.push({ outcome, details });
    },
    span,
  };
  const published = options.published ?? {};
  const names: NameSource = {
    resolveProduct: vi.fn((label: string, onPhase?: (phase: ResolvePhase) => void) => {
      onPhase?.('asset-hub-syncing');
      return options.resolveError !== undefined
        ? Promise.reject(options.resolveError)
        : Promise.resolve(published[`app.${label}`] ?? published[label] ?? null);
    }),
    readManifests: vi.fn(() => Promise.resolve(NO_MANIFESTS)),
    readWorkerManifest: vi.fn(() => Promise.resolve({ kind: 'empty' as const })),
  };
  const deps: ProductLoaderDeps = {
    backend,
    skipCidCache: options.skipCidCache ?? false,
    network: () => 'paseo-next-v2',
    flowId: 'boot-1',
    startedAt: 0,
    emit: event => {
      debug.push(event);
    },
    frame: {
      setPageProduct: vi.fn(() => {
        order.push('setPageProduct');
      }),
      render: vi.fn(() => {
        order.push('render');
        return Promise.resolve();
      }),
    },
    names,
    cidCache: {
      get: vi.fn(() => Promise.resolve(options.cached ?? null)),
      set: (label, cid) => {
        cacheWrites.push({ label, cid });
        return Promise.resolve();
      },
    },
    journey: {
      begin: () => ({ journeyId: 'journey-1', attemptNumber: 1, entry: 'navigation' }),
      end: vi.fn(),
    },
    startTrace: () => trace,
    startProgress: () => progress,
    onContentDone: callback => {
      contentCallbacks.push(callback);
    },
    smoldotDbOutcome: () => 'hit',
    primeChat: vi.fn(),
    scheduleNotifications: vi.fn(),
    revalidate: vi.fn(() => Promise.resolve()),
    brand: vi.fn(() => Promise.resolve()),
    page: {
      showProductPill: vi.fn(),
      settleShield: vi.fn(),
      showNoContent: vi.fn(),
      setProductError: vi.fn(),
      setContentShown: vi.fn(),
      recordRecentLabel: vi.fn(() => Promise.resolve()),
    },
    presentFailure: failure => {
      failures.push(failure);
      return options.presentFailure?.() ?? Promise.resolve();
    },
    forgetFailure: vi.fn(),
    idle: callback => {
      idle.push(callback);
    },
  };
  return {
    loader: createProductLoader(deps),
    deps,
    trace: { steps, finished },
    failures,
    debug,
    cacheWrites,
    reportContent: (outcome, failedStep) => {
      for (const callback of contentCallbacks.splice(0)) {
        callback(outcome, failedStep);
      }
    },
    runIdle: () => {
      for (const callback of idle.splice(0)) {
        callback();
      }
    },
    order,
    progress,
  };
}

function events(debug: DotliDebugEvent[]): string[] {
  return debug.map(event => `${event.layer}:${event.event}`);
}

// Settings come from a memory store, not Node's localStorage, and the previous store is put back after each test.
beforeEach(() => configureModeStorage(memoryModeStorage()));

describe('createProductLoader', () => {
  const captured: CaptureContext[] = [];
  const expectedMisses: { err: unknown; ctx: unknown }[] = [];
  let unbind: () => void;
  /** Settles at the first expected miss reported. */
  let missReported: Promise<void> = Promise.resolve();

  beforeEach(() => {
    captured.length = 0;
    expectedMisses.length = 0;
    let markMissed: () => void = () => undefined;
    missReported = new Promise(resolve => {
      markMissed = resolve;
    });
    unbind = bindCaptureSink({
      exception: (_err, ctx) => {
        captured.push(ctx);
      },
      expected: (err, ctx) => {
        expectedMisses.push({ err, ctx });
        markMissed();
      },
    });
  });

  afterEach(() => {
    unbind();
    bindLogSink({ emit: () => undefined });
  });

  it('As a visitor opening a name for the first time, I get its app subname content rendered and remembered for next time', async () => {
    // Given
    const { loader, deps, trace, debug, cacheWrites, runIdle, order, progress } = harness({
      published: { 'app.doom': 'bafy-app', doom: 'bafy-base' },
    });

    // When
    await loader.load('doom');
    runIdle();

    // Then
    expect(order).toEqual(['setPageProduct', 'render']);
    expect(deps.frame.render).toHaveBeenCalledWith({ mode: 'subdomain', label: 'doom', cid: 'bafy-app' });
    expect(deps.page.settleShield).toHaveBeenCalledWith('verified');
    expect(progress.resolvePhase).toHaveBeenCalledWith('asset-hub-syncing');
    expect(progress.nameResolved).toHaveBeenCalledTimes(1);
    expect(trace.steps).toEqual([
      'cid_cache_read',
      'name_resolve',
      'manifest_read',
      'launch_gate',
      'render_handoff',
      'content',
    ]);
    expect(cacheWrites).toEqual([{ label: 'doom', cid: 'bafy-app' }]);
    expect(deps.forgetFailure).toHaveBeenCalledTimes(1);
    expect(deps.brand).toHaveBeenCalledWith('doom', NO_MANIFESTS);
    expect(events(debug)).toEqual([
      'boot:cid_cache_checked',
      'resolve:started',
      'resolve:phase',
      'resolve:completed',
      'boot:ready',
    ]);
    expect(debug.find(event => event.event === 'phase')?.payload).toEqual({
      label: 'doom',
      phase: 'asset-hub-syncing',
    });
  });

  it('As a visitor returning to a cached app, I see it without a name read, and it is checked once the page is idle', async () => {
    // Given
    const { loader, deps, runIdle, debug } = harness({
      cached: { cid: 'bafy-cached', manifests: NO_CACHED_MANIFESTS },
    });

    // When
    await loader.load('doom');
    runIdle();

    // Then
    expect(deps.names.resolveProduct).not.toHaveBeenCalled();
    expect(deps.frame.render).toHaveBeenCalledWith({ mode: 'subdomain', label: 'doom', cid: 'bafy-cached' });
    expect(deps.revalidate).toHaveBeenCalledWith('doom', 'bafy-cached', true);
    expect(debug.at(-1)?.payload).toMatchObject({ label: 'doom', path: 'fast' });
  });

  it('As a visitor returning to a cached app whose check cannot be fetched, I keep the app and the miss is logged', async () => {
    // Given
    const chunkMiss = new TypeError('Failed to fetch dynamically imported module');
    const { loader, deps, runIdle } = harness({
      cached: { cid: 'bafy-cached', manifests: NO_CACHED_MANIFESTS },
    });
    const warned: string[] = [];
    const warning = new Promise<void>(resolve => {
      bindLogSink({
        emit: (level: LogLevel, message: string) => {
          if (level === 'warn') {
            warned.push(message);
            resolve();
          }
        },
      });
    });
    deps.revalidate = vi.fn(() => Promise.reject(chunkMiss));

    // When
    await loader.load('doom');
    runIdle();

    // Then
    await warning;
    expect(warned).toHaveLength(1);
    expect(expectedMisses).toEqual([{ err: chunkMiss, ctx: { flow: 'resolve', step: 'cache_revalidation_load' } }]);
    expect(deps.page.setProductError).not.toHaveBeenCalled();
  });

  it('As a visitor whose branding chunk fails to load, the app stays and the miss is reported once', async () => {
    // Given
    const chunkMiss = new TypeError('Failed to fetch dynamically imported module');
    const { loader, deps } = harness({ published: { 'app.doom': 'bafy-app', doom: 'bafy-base' } });
    deps.brand = vi.fn(() => Promise.reject(chunkMiss));

    // When
    await loader.load('doom');

    // Then
    await missReported;
    expect(expectedMisses).toEqual([{ err: chunkMiss, ctx: { flow: 'resolve', step: 'product_branding_load' } }]);
    expect(deps.page.setProductError).not.toHaveBeenCalled();
  });

  it('As a visitor whose cached copy no longer passes, I see why, and the copy is checked without reloading me', async () => {
    // Given
    const { loader, deps, failures, runIdle } = harness({
      cached: { cid: 'bafy-cached', manifests: { root: '{"$v":2}', app: null } },
    });

    // When
    await loader.load('doom');
    runIdle();

    // Then
    expect(deps.frame.render).not.toHaveBeenCalled();
    expect(failures.map(failure => failure.error.kind)).toEqual(['manifest-unsupported-version']);
    expect(deps.page.setProductError).toHaveBeenCalledTimes(1);
    expect(deps.revalidate).toHaveBeenCalledWith('doom', 'bafy-cached', false);
  });

  it('As a visitor on a name with nothing published, I see the no-content screen and my journey ends', async () => {
    // Given
    const { loader, deps, trace, failures } = harness();

    // When
    await loader.load('doom');

    // Then
    expect(deps.page.showNoContent).toHaveBeenCalledWith('doom');
    expect(deps.page.setProductError).toHaveBeenCalledTimes(1);
    expect(deps.journey.end).toHaveBeenCalledTimes(1);
    expect(trace.finished).toEqual([{ outcome: 'no_content', details: undefined }]);
    expect(deps.frame.render).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
  });

  it('As a visitor whose name read fails, I see the failure screen, and the operator gets one report naming the step', async () => {
    // Given
    const cause = new Error('Asset Hub went quiet');
    const { loader, deps, trace, failures } = harness({ resolveError: cause });

    // When
    await loader.load('doom');

    // Then
    expect(captured.map(ctx => ctx.step)).toEqual(['name_resolve']);
    expect(captured[0]?.tags).toMatchObject({
      cid_cache: 'miss',
      chain_backend: 'smoldot-direct',
      smoldotdb_hub_cache: 'hit',
    });
    expect(trace.finished.map(entry => entry.outcome)).toEqual(['error']);
    expect(failures).toEqual([expect.objectContaining({ cause, label: 'doom', backend: 'smoldot-direct' })]);
    expect(deps.page.setProductError).toHaveBeenCalledTimes(1);
  });

  it('As a visitor whose name read fails, I see the load settle only once the failure screen is up', async () => {
    // Given a failure screen still being fetched
    let screenUp = (): void => undefined;
    const screen = new Promise<void>(resolve => {
      screenUp = resolve;
    });
    let presenting = (): void => undefined;
    const presented = new Promise<void>(resolve => {
      presenting = resolve;
    });
    const { loader, failures } = harness({
      resolveError: new Error('Asset Hub went quiet'),
      presentFailure: () => {
        presenting();
        return screen;
      },
    });
    let settled = false;

    // When
    const loaded = loader.load('doom').then(() => {
      settled = true;
    });
    await presented;
    expect(failures).toHaveLength(1);
    // More microtask turns than a load that skipped the wait would need to settle.
    for (let turn = 0; turn < 10; turn += 1) {
      await Promise.resolve();
    }

    // Then it waits for the screen
    expect(settled).toBe(false);

    // When the screen is up
    screenUp();
    await loaded;

    // Then
    expect(settled).toBe(true);
  });

  it('As a visitor whose failure screen itself fails, I see the load reject with that failure', async () => {
    // Given
    const screenFailure = new Error('the failure screen threw');
    const { loader } = harness({
      resolveError: new Error('Asset Hub went quiet'),
      presentFailure: () => Promise.reject(screenFailure),
    });

    // When
    const loaded = loader.load('doom');

    // Then
    await expect(loaded).rejects.toBe(screenFailure);
  });

  it('As a visitor, I see the content shown once the sandbox reports it loaded, and that ends my journey', async () => {
    // Given
    const { loader, deps, trace, reportContent } = harness({ published: { doom: 'bafy-base' } });
    await loader.load('doom');

    // When
    reportContent('loaded');

    // Then
    expect(deps.page.setContentShown).toHaveBeenCalledWith(true);
    expect(deps.journey.end).toHaveBeenCalledTimes(1);
    expect(trace.finished).toEqual([{ outcome: 'rendered', details: undefined }]);
  });

  it('As a visitor whose download fails in the sandbox, I keep the sandbox screen and the trace names the failed step', async () => {
    // Given
    const { loader, deps, trace, reportContent } = harness({ published: { doom: 'bafy-base' } });
    await loader.load('doom');

    // When
    reportContent('failed', 'archive_fetch');

    // Then
    expect(deps.page.setContentShown).toHaveBeenCalledWith(false);
    expect(deps.journey.end).not.toHaveBeenCalled();
    expect(trace.finished).toEqual([{ outcome: 'content_error', details: { failedStep: 'archive_fetch' } }]);
  });

  it("As a visitor on a gateway, I am shown as trusted and the resolver's phases go to the load progress, which owns the gateway's bands", async () => {
    // Given
    const { loader, deps, progress } = harness({ backend: 'rpc-gateway', published: { doom: 'bafy-base' } });

    // When
    await loader.load('doom');

    // Then
    expect(deps.page.settleShield).toHaveBeenCalledWith('trusted');
    expect(progress.resolvePhase).toHaveBeenCalledWith('asset-hub-syncing');
  });

  it('As a visitor with the CID cache turned off, I resolve the name every time and nothing is cached', async () => {
    // Given
    const { loader, deps, cacheWrites, runIdle } = harness({ skipCidCache: true, published: { doom: 'bafy-base' } });

    // When
    await loader.load('doom');
    runIdle();

    // Then
    expect(deps.cidCache.get).not.toHaveBeenCalled();
    expect(cacheWrites).toEqual([]);
    expect(deps.frame.render).toHaveBeenCalledWith({ mode: 'subdomain', label: 'doom', cid: 'bafy-base' });
  });

  it('As a visitor, a second load of the same name waits for the first and loads nothing more', async () => {
    // Given
    const { loader, deps } = harness({ published: { doom: 'bafy-base' } });

    // When
    await Promise.all([loader.load('doom'), loader.load('doom')]);

    // Then
    expect(deps.names.resolveProduct).toHaveBeenCalledTimes(1);
    expect(deps.frame.render).toHaveBeenCalledTimes(1);
  });
});
