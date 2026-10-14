// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product loader on a page. The name source, the frame and the recent list sit in other frames or origins, and the
// CID cache and the failure screen reload or write the page, so all five are fakes. The URL pill, the product state,
// the journey, the resolution trace and the debug panel's events are the page's own. The trace keeps only its last
// step, so the step sequence is not asserted. The content-shown flag and the branding are covered by the topbar
// autohide and product branding specs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush } from 'solid-js';
import type { Backend } from '@dotli/config';
import { bindCaptureSink, m, type CaptureContext } from '@dotli/metrics';
import type { ExecutableManifest, ManifestResult, ResolvePhase } from '@dotli/resolver';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import type { CachedManifests } from '@dotli/storage';
import { enableDotliDebugBuffering, watchDotliDebugEvents, type DotliDebugEvent } from '@dotli/truapi-debug';
import { clearScreen } from '@dotli/ui';
import type { LoadFailure } from '../../src/load-failure.js';
import { pageLoading } from '../../src/loading-controller.js';
import type { NameSource } from '../../src/name-source.js';
import {
  createProductLoader,
  type ContentOutcome,
  type LoaderCidCache,
  type LoaderFrame,
} from '../../src/product-loader.js';
import { getProductState } from '../../src/runtime/state/product.js';
import { urlPillStore } from '../../src/state/url-pill.js';

const NO_MANIFESTS = { root: { kind: 'empty' as const }, app: { kind: 'empty' as const } };
const NO_CACHED_MANIFESTS: CachedManifests = { root: null, app: null };

function workerManifest(
  value: { kind: 'app' } | { kind: 'worker'; entrypoint: string; includes: { chat?: boolean } },
): ManifestResult<ExecutableManifest> {
  return { kind: 'ok', value: { $v: 1, appVersion: [1, 0, 0], ...value }, raw: '' };
}

/** The resolution span's attributes as the trace sets them, through a Sentry bound until `restore`. */
function recordResolution(): { root: () => Record<string, unknown> | undefined; restore: () => void } {
  const roots: Record<string, unknown>[] = [];
  const inert = (): void => undefined;
  const sentry: unknown = {
    startInactiveSpan: (opts: { name: string; attributes?: Record<string, unknown> }) => {
      const attributes: Record<string, unknown> = { ...opts.attributes };
      if (opts.name === 'dotli.resolution') {
        roots.push(attributes);
      }
      return {
        setAttributes: (next: Record<string, unknown>) => {
          Object.assign(attributes, next);
        },
        end: inert,
      };
    },
    startSpan: <T>(_opts: unknown, fn: (span: undefined) => T): T => fn(undefined),
    setMeasurement: inert,
    metrics: { count: inert, distribution: inert, gauge: inert },
    setTag: inert,
    addBreadcrumb: inert,
  };
  const restore = m.bind(sentry as Parameters<typeof m.bind>[0]);
  return { root: () => roots.at(-1), restore };
}

interface Options {
  backend?: Backend;
  /** Contenthashes by name. */
  published?: Record<string, string>;
  cached?: { cid: string; manifests: CachedManifests };
  skipCidCache?: boolean;
  /** What the worker manifest read answers. An empty manifest without it. */
  workerManifest?: ManifestResult<ExecutableManifest>;
  resolveError?: Error;
  /** Thrown as the failure screen shows. */
  failToShow?: Error;
}

function harness(options: Options = {}) {
  const order: string[] = [];
  const failures: LoadFailure[] = [];
  const contentDone: ((outcome: ContentOutcome, failedStep: string | undefined) => void)[] = [];
  const stored: string[] = [];
  const revalidated: [string, string, boolean][] = [];
  const recorded: string[] = [];
  let forgotten = 0;
  const published = options.published ?? {};
  const names: NameSource = {
    resolveProduct: vi.fn((label: string, onPhase?: (phase: ResolvePhase) => void) => {
      onPhase?.('asset-hub-syncing');
      return options.resolveError !== undefined
        ? Promise.reject(options.resolveError)
        : Promise.resolve(published[`app.${label}`] ?? published[label] ?? null);
    }),
    readManifests: vi.fn(() => Promise.resolve(NO_MANIFESTS)),
    readWorkerManifest: vi.fn(() => Promise.resolve(options.workerManifest ?? { kind: 'empty' as const })),
  };
  const frame = {
    setPageProduct: vi.fn(() => {
      order.push('setPageProduct');
    }),
    render: vi.fn<LoaderFrame['render']>(() => {
      order.push('render');
      return Promise.resolve();
    }),
    onContentDone: callback => {
      contentDone.push(callback);
    },
    onContentProgress: () => () => undefined,
  } satisfies LoaderFrame;
  const cidCache = {
    get: vi.fn<LoaderCidCache['get']>(() => Promise.resolve(options.cached ?? null)),
    storeLater: (label, cid) => {
      stored.push(`${label} ${cid}`);
    },
    revalidateLater: (label, servedCid, onScreen) => {
      revalidated.push([label, servedCid, onScreen]);
    },
  } satisfies LoaderCidCache;
  const loader = createProductLoader({
    backend: options.backend ?? 'smoldot-direct',
    skipCidCache: options.skipCidCache ?? false,
    flowId: 'boot-1',
    startedAt: 0,
    names,
    frame,
    cidCache,
    recents: {
      record: label => {
        recorded.push(label);
        return Promise.resolve();
      },
    },
    failureScreen: {
      show: failure => {
        failures.push(failure);
        if (options.failToShow !== undefined) {
          throw options.failToShow;
        }
      },
      forget: () => {
        forgotten += 1;
      },
    },
  });
  return {
    loader,
    names,
    frame,
    cidCache,
    order,
    failures,
    stored,
    revalidated,
    recorded,
    forgotten: () => forgotten,
    reportContent: (outcome: ContentOutcome, failedStep?: string) => {
      for (const callback of contentDone.splice(0)) {
        callback(outcome, failedStep);
      }
    },
  };
}

const JOURNEY_KEY = 'dotli:journey';

describe('createProductLoader', () => {
  const captured: CaptureContext[] = [];
  const debug: DotliDebugEvent[] = [];
  const undo: (() => void)[] = [];
  let resolution: () => Record<string, unknown> | undefined;

  const events = (): string[] => debug.map(event => `${event.layer}:${event.event}`);

  beforeEach(() => {
    captured.length = 0;
    debug.length = 0;
    localStorage.clear();
    sessionStorage.clear();
    resetAllStoresForTests();
    enableDotliDebugBuffering();
    undo.push(
      watchDotliDebugEvents(event => {
        if ('layer' in event) {
          debug.push(event);
        }
      }),
      bindCaptureSink({
        exception: (_err, ctx) => {
          captured.push(ctx);
        },
        expected: () => undefined,
      }),
    );
    const recorder = recordResolution();
    undo.push(recorder.restore);
    resolution = recorder.root;
  });

  afterEach(() => {
    // The load starts the page's loading screen, and the no-content test leaves a screen mounted.
    pageLoading.stopStatusTick();
    clearScreen();
    for (const restore of undo.splice(0).reverse()) {
      restore();
    }
  });

  it('As a visitor opening a name for the first time, I get its app subname content rendered as verified, and it is remembered for next time', async () => {
    // Given
    const { loader, frame, order, stored, recorded, forgotten } = harness({
      published: { 'app.doom': 'bafy-app', doom: 'bafy-base' },
    });

    // When
    await loader.load('doom');

    // Then
    expect(order).toEqual(['setPageProduct', 'render']);
    expect(frame.render).toHaveBeenCalledWith({
      mode: 'subdomain',
      label: 'doom',
      cid: 'bafy-app',
      chat: expect.any(Promise) as unknown,
    });
    expect(urlPillStore.get()).toMatchObject({ kind: 'product', domain: 'doom', shield: 'verified' });
    expect(stored).toEqual(['doom bafy-app']);
    expect(recorded).toEqual(['doom']);
    expect(forgotten()).toBe(1);
    expect(events()).toEqual([
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

  it('As a visitor opening a product whose worker manifest includes chat, I get it rendered with chat on', async () => {
    // Given
    const { loader, frame } = harness({
      published: { doom: 'bafy-base' },
      workerManifest: workerManifest({ kind: 'worker', entrypoint: 'index.js', includes: { chat: true } }),
    });

    // When
    await loader.load('doom');

    // Then
    await expect(frame.render.mock.calls[0]?.[0].chat).resolves.toBe(true);
  });

  it.each([
    ['an app manifest', workerManifest({ kind: 'app' })],
    ['an empty manifest', { kind: 'empty' } as const],
  ])('As a visitor opening a product with %s, I get it rendered with chat off', async (_name, manifest) => {
    // Given
    const { loader, frame } = harness({ published: { doom: 'bafy-base' }, workerManifest: manifest });

    // When
    await loader.load('doom');

    // Then
    await expect(frame.render.mock.calls[0]?.[0].chat).resolves.toBe(false);
  });

  it('As a visitor returning to a cached app, I see it without a name read, and it is checked against the network', async () => {
    // Given
    const { loader, names, frame, revalidated } = harness({
      cached: { cid: 'bafy-cached', manifests: NO_CACHED_MANIFESTS },
    });

    // When
    await loader.load('doom');

    // Then
    expect(names.resolveProduct).not.toHaveBeenCalled();
    expect(frame.render).toHaveBeenCalledWith({
      mode: 'subdomain',
      label: 'doom',
      cid: 'bafy-cached',
      chat: expect.any(Promise) as unknown,
    });
    expect(revalidated).toEqual([['doom', 'bafy-cached', true]]);
    expect(debug.at(-1)?.payload).toMatchObject({ label: 'doom', path: 'fast' });
  });

  it('As a visitor whose cached copy no longer passes, I see why, and the copy is checked without reloading me', async () => {
    // Given
    const { loader, frame, failures, revalidated } = harness({
      cached: { cid: 'bafy-cached', manifests: { root: '{"$v":2}', app: null } },
    });

    // When
    await loader.load('doom');

    // Then
    expect(frame.render).not.toHaveBeenCalled();
    expect(failures.map(failure => failure.error.kind)).toEqual(['manifest-unsupported-version']);
    expect(getProductState().status).toBe('error');
    expect(revalidated).toEqual([['doom', 'bafy-cached', false]]);
    expect(captured[0]?.step).toBe('cached_launch_gate');
    expect(captured[0]?.tags).toMatchObject({ smoldotdb_hub_cache: 'n/a' });
  });

  it('As a visitor on a name with nothing published, I see the no-content screen and my journey ends', async () => {
    // Given
    const { loader, frame, failures } = harness();

    // When
    await loader.load('doom');
    flush();

    // Then
    expect(document.querySelector('[data-testid="error-page-domain"]')?.textContent).toContain('doom');
    expect(getProductState().status).toBe('error');
    expect(sessionStorage.getItem(JOURNEY_KEY)).toBeNull();
    expect(resolution()).toMatchObject({ outcome: 'no_content' });
    expect(frame.render).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
  });

  it('As a visitor whose name read fails, I see the failure screen, and the operator gets one report naming the step', async () => {
    // Given
    const cause = new Error('Asset Hub went quiet');
    const { loader, failures } = harness({ resolveError: cause });

    // When
    await loader.load('doom');

    // Then
    expect(captured.map(ctx => ctx.step)).toEqual(['name_resolve']);
    expect(captured[0]?.tags).toMatchObject({
      cid_cache: 'miss',
      chain_backend: 'smoldot-direct',
      smoldotdb_hub_cache: 'unknown',
    });
    expect(resolution()).toMatchObject({ outcome: 'error' });
    expect(failures).toEqual([expect.objectContaining({ cause, label: 'doom', backend: 'smoldot-direct' })]);
    expect(getProductState().status).toBe('error');
  });

  it('As a visitor whose failure screen itself fails, I see the load reject with that failure', async () => {
    // Given
    const screenFailure = new Error('the failure screen threw');
    const { loader } = harness({ resolveError: new Error('Asset Hub went quiet'), failToShow: screenFailure });

    // When
    const loaded = loader.load('doom');

    // Then
    await expect(loaded).rejects.toBe(screenFailure);
  });

  it('As a visitor, my journey ends once the sandbox reports the content loaded', async () => {
    // Given
    const { loader, reportContent } = harness({ published: { doom: 'bafy-base' } });
    await loader.load('doom');
    const journeyBefore = sessionStorage.getItem(JOURNEY_KEY);

    // When
    reportContent('loaded');

    // Then
    expect(journeyBefore).not.toBeNull();
    expect(sessionStorage.getItem(JOURNEY_KEY)).toBeNull();
    expect(resolution()).toMatchObject({ outcome: 'rendered', loading_phase: 'content' });
  });

  it('As a visitor whose download fails in the sandbox, my journey goes on and the trace names the failed step', async () => {
    // Given
    const { loader, reportContent } = harness({ published: { doom: 'bafy-base' } });
    await loader.load('doom');

    // When
    reportContent('failed', 'archive_fetch');

    // Then
    expect(sessionStorage.getItem(JOURNEY_KEY)).not.toBeNull();
    expect(resolution()).toMatchObject({ outcome: 'content_error', failed_step: 'archive_fetch' });
  });

  it('As a visitor on a gateway, I am shown the app as trusted', async () => {
    // Given
    const { loader } = harness({ backend: 'rpc-gateway', published: { doom: 'bafy-base' } });

    // When
    await loader.load('doom');

    // Then
    expect(urlPillStore.get()).toMatchObject({ kind: 'product', domain: 'doom', shield: 'trusted' });
    expect(debug.find(event => event.event === 'phase')?.payload).toEqual({
      label: 'doom',
      phase: 'asset-hub-syncing',
    });
  });

  it('As a visitor with the CID cache turned off, I resolve the name every time and nothing is cached', async () => {
    // Given
    const { loader, cidCache, stored, frame } = harness({ skipCidCache: true, published: { doom: 'bafy-base' } });

    // When
    await loader.load('doom');

    // Then
    expect(cidCache.get).not.toHaveBeenCalled();
    expect(stored).toEqual([]);
    expect(frame.render).toHaveBeenCalledWith({
      mode: 'subdomain',
      label: 'doom',
      cid: 'bafy-base',
      chat: expect.any(Promise) as unknown,
    });
  });

  it('As a visitor, a second load of the same name waits for the first and loads nothing more', async () => {
    // Given
    const { loader, names, frame } = harness({ published: { doom: 'bafy-base' } });

    // When
    await Promise.all([loader.load('doom'), loader.load('doom')]);

    // Then
    expect(names.resolveProduct).toHaveBeenCalledTimes(1);
    expect(frame.render).toHaveBeenCalledTimes(1);
  });
});
