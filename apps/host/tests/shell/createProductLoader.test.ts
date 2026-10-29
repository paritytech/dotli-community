// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product loader on a page. The name source, the frame and the recent list sit in other frames or origins, and the
// CID cache and the failure screen reload or write the page, so all five are fakes. The URL pill, the product state,
// the journey, the resolution trace and the debug panel's events are the page's own. The trace keeps only its last
// step, so the step sequence is not asserted.

import { bindRecordingSentry } from '@dotli/metrics/testing';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { flush } from 'solid-js';
import type { Backend } from '@dotli/config';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { ProtocolVersionMismatchError } from '@dotli/protocol';
import type { ExecutableManifest, ManifestResult } from '@dotli/resolver';
import { createManualTimers, resetAllStoresForTests } from '@dotli/shared/testing';
import type { CachedManifests } from '@dotli/storage';
import { debugBus, type DotliDebugEvent } from '@dotli/truapi-debug';
import { pageScreen } from '@dotli/ui';
import { beginAttempt } from '../../src/journey.js';
import type { LoadFailure } from '../../src/presentLoadFailure.js';
import { pageLoading } from '../../src/createLoadingController.js';
import type { NameSource } from '../../src/createNameSource.js';
import {
  createProductLoader,
  type ContentOutcome,
  type LoaderCidCache,
  type LoaderFrame,
} from '../../src/createProductLoader.js';
import { productState } from '../../src/runtime/state/productState.js';
import { urlPillState } from '../../src/state/urlPillState.js';

type Params = {
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
  /** The sandbox never says anything. It speaks at once without it. */
  silentSandbox?: boolean;
  /** A protocol frame refused this page's wire version before the load asked, so its listener hears it at once. */
  latchedMismatch?: ProtocolVersionMismatchError;
};

const NO_MANIFESTS = { root: { kind: 'empty' as const }, app: { kind: 'empty' as const } };
const NO_CACHED_MANIFESTS: CachedManifests = { root: null, app: null };

describe('createProductLoader', () => {
  it('As a visitor, I open a name for the first time and get its app subname content rendered', async () => {
    // Given
    const { loader, frame, listEvents } = setupLoader({ published: { 'app.doom': 'bafy-app', doom: 'bafy-base' } });

    // When
    await loader.load('doom');

    // Then
    expect(frame.render).toHaveBeenCalledWith(getRenderedDoom('bafy-app'));
    expect(listEvents()).toContain('boot:ready');
  });

  it('As a visitor, I open a name for the first time and see its URL pill as verified', async () => {
    // Given
    const { loader } = setupLoader({ published: { 'app.doom': 'bafy-app', doom: 'bafy-base' } });

    // When
    await loader.load('doom');

    // Then
    expect(urlPillState.store.get()).toMatchObject({ kind: 'product', domain: 'doom', shield: 'verified' });
  });

  it('As a visitor, I open a name for the first time and it is remembered for next time', async () => {
    // Given
    const { loader, stored, recents, countForgotten } = setupLoader({
      published: { 'app.doom': 'bafy-app', doom: 'bafy-base' },
    });

    // When
    await loader.load('doom');

    // Then
    expect(stored).toEqual(['doom bafy-app']);
    expect(recents).toEqual(['doom']);
    expect(countForgotten()).toBe(1);
  });

  it.each([
    [
      'a worker manifest that includes chat',
      'on',
      createWorkerManifest({ kind: 'worker', entrypoint: 'index.js', includes: { chat: true } }),
      true,
    ],
    ['an app manifest', 'off', createWorkerManifest({ kind: 'app' }), false],
    ['an empty manifest', 'off', { kind: 'empty' } as const, false],
  ])(
    'As a visitor, I open a product with %s and get it rendered with chat %s',
    async (_name, _chat, manifest, chatOn) => {
      // Given
      const { loader, frame } = setupLoader({ published: { doom: 'bafy-base' }, workerManifest: manifest });

      // When
      await loader.load('doom');

      // Then
      await expect(frame.render.mock.calls[0]?.[0].chat).resolves.toBe(chatOn);
    },
  );

  it('As a visitor, I return to a cached app and see it without a name read while it is checked against the network', async () => {
    // Given
    const { loader, names, frame, revalidated, debug } = setupLoader({
      cached: { cid: 'bafy-cached', manifests: NO_CACHED_MANIFESTS },
    });

    // When
    await loader.load('doom');

    // Then
    expect(names.resolveProduct).not.toHaveBeenCalled();
    expect(frame.render).toHaveBeenCalledWith(getRenderedDoom('bafy-cached'));
    expect(revalidated).toEqual([['doom', 'bafy-cached', true]]);
    expect(debug.at(-1)?.payload).toMatchObject({ label: 'doom', path: 'fast' });
  });

  it('As a visitor whose cached copy no longer passes, I open it and see why, and the copy is checked without reloading me', async () => {
    // Given
    const { loader, frame, failures, revalidated, captured } = setupLoader({
      cached: { cid: 'bafy-cached', manifests: { root: '{"$v":2}', app: null } },
    });

    // When
    await loader.load('doom');

    // Then
    expect(frame.render).not.toHaveBeenCalled();
    expect(failures.map(failure => failure.error.kind)).toEqual(['manifest-unsupported-version']);
    expect(productState.get().status).toBe('error');
    expect(revalidated).toEqual([['doom', 'bafy-cached', false]]);
    expect(captured[0]?.step).toBe('cached_launch_gate');
    expect(captured[0]?.tags).toMatchObject({ smoldotdb_hub_cache: 'n/a' });
  });

  it('As a visitor, I open a name with nothing published and see the no-content screen, and my journey ends', async () => {
    // Given
    const { loader, frame, failures, readResolution } = setupLoader();

    // When the load ends, and the name is opened again
    await loader.load('doom');
    flush();
    const nextAttempt = beginAttempt('doom');

    // Then
    expect(document.querySelector('[data-testid="error-page-domain"]')?.textContent).toContain('doom');
    expect(productState.get().status).toBe('error');
    expect(nextAttempt.attemptNumber).toBe(1);
    expect(readResolution()).toMatchObject({ outcome: 'no_content' });
    expect(frame.render).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
  });

  it('As a visitor, I open a name whose read fails and see the failure screen, and the operator gets one report naming the step', async () => {
    // Given
    const cause = new Error('Asset Hub went quiet');
    const { loader, failures, captured, readResolution } = setupLoader({ resolveError: cause });

    // When
    await loader.load('doom');

    // Then
    expect(captured.map(context => context.step)).toEqual(['name_resolve']);
    expect(captured[0]?.tags).toMatchObject({
      cid_cache: 'miss',
      chain_backend: 'smoldot-direct',
      smoldotdb_hub_cache: 'unknown',
    });
    expect(readResolution()).toMatchObject({ outcome: 'error' });
    expect(failures).toEqual([expect.objectContaining({ cause, label: 'doom', backend: 'smoldot-direct' })]);
    expect(productState.get().status).toBe('error');
  });

  it('As a visitor whose failure screen itself fails, I open a name and the load rejects with that failure', async () => {
    // Given
    const screenFailure = new Error('the failure screen threw');
    const { loader } = setupLoader({ resolveError: new Error('Asset Hub went quiet'), failToShow: screenFailure });

    // When
    const loaded = loader.load('doom');

    // Then
    await expect(loaded).rejects.toBe(screenFailure);
  });

  it('As a visitor, I see the sandbox report the content loaded and my journey ends', async () => {
    // Given
    const { loader, reportContent, readResolution } = setupLoader({ published: { doom: 'bafy-base' } });
    await loader.load('doom');

    // When the content loads, and the name is opened again
    reportContent('loaded');
    const nextAttempt = beginAttempt('doom');

    // Then
    expect(nextAttempt.attemptNumber).toBe(1);
    expect(readResolution()).toMatchObject({ outcome: 'rendered', loading_phase: 'content' });
  });

  it('As a visitor, I meet a download failure in the sandbox and my journey goes on, with the trace naming the failed step', async () => {
    // Given
    const { loader, reportContent, readResolution } = setupLoader({ published: { doom: 'bafy-base' } });
    await loader.load('doom');

    // When the download fails, and the name is opened again
    reportContent('failed', 'archive_fetch');
    const nextAttempt = beginAttempt('doom');

    // Then
    expect(nextAttempt.attemptNumber).toBe(2);
    expect(readResolution()).toMatchObject({ outcome: 'content_error', failed_step: 'archive_fetch' });
  });

  it('As a visitor, I open an app whose frame never starts and see the failure screen after its deadline instead of a loading bar for good', async () => {
    // Given
    const { loader, frame, failures, reportContent, timers, captured, readResolution } = setupLoader({
      published: { doom: 'bafy-base' },
      silentSandbox: true,
    });
    await loader.load('doom');

    // When
    await timers.advance(30_000);
    reportContent('loaded');

    // Then
    expect(failures.map(failure => failure.error.kind)).toEqual(['sandbox-silent']);
    expect(captured).toContainEqual(expect.objectContaining({ step: 'content' }));
    expect(readResolution()).toMatchObject({ outcome: 'error', error_kind: 'sandbox-silent' });
    expect(frame.halt).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['for the first time', {}],
    ['from the CID cache', { cached: { cid: 'bafy-cached', manifests: NO_CACHED_MANIFESTS } }],
  ])(
    'As a visitor whose protocol frame refused this page, I open a name %s and see the reload screen, and the load ends there',
    async (_path, given) => {
      // Given
      const {
        loader,
        frame,
        failures,
        recents,
        countForgotten,
        countSandboxListeners,
        reportContent,
        listEvents,
        readResolution,
        distributions,
      } = setupLoader({
        published: { doom: 'bafy-base' },
        latchedMismatch: new ProtocolVersionMismatchError('the frame speaks a newer wire'),
        silentSandbox: true,
        ...given,
      });

      // When
      await loader.load('doom');
      reportContent('loaded');

      // Then
      expect(failures.map(failure => failure.error.kind)).toEqual(['protocol-version-mismatch']);
      expect(frame.halt).toHaveBeenCalledTimes(1);
      expect(countForgotten()).toBe(0);
      expect(recents).toEqual([]);
      expect(listEvents()).not.toContain('boot:ready');
      expect(readResolution()).toMatchObject({ outcome: 'error', error_kind: 'protocol-version-mismatch' });
      expect(listEvents().filter(event => event === 'boot:failed')).toEqual(['boot:failed']);
      expect(
        distributions.filter(
          metric => metric.name === 'dotli.e2e.slow_path' && metric.attributes?.['outcome'] === 'ok',
        ),
      ).toEqual([]);
      expect(countSandboxListeners()).toBe(0);
    },
  );

  it('As a visitor with the app open, I meet a protocol frame rebuilt from a newer release and the app goes down under the reload screen', async () => {
    // Given
    const { loader, frame, failures, refuseWire, reportContent, readResolution } = setupLoader({
      published: { doom: 'bafy-base' },
    });
    await loader.load('doom');

    // When
    refuseWire(new ProtocolVersionMismatchError('the frame speaks a newer wire'));
    reportContent('loaded');

    // Then
    expect(failures.map(failure => failure.error.kind)).toEqual(['protocol-version-mismatch']);
    expect(frame.halt).toHaveBeenCalledTimes(1);
    expect(readResolution()).toMatchObject({ outcome: 'error', error_kind: 'protocol-version-mismatch' });
  });

  it('As a visitor with the app open, I meet a failure that ends the load and it stops waiting for the content', async () => {
    // Given
    const { loader, refuseWire, countContentCallbacks } = setupLoader({ published: { doom: 'bafy-base' } });
    await loader.load('doom');

    // When
    refuseWire(new ProtocolVersionMismatchError('the frame speaks a newer wire'));

    // Then
    expect(countContentCallbacks()).toBe(0);
  });

  it('As a visitor whose app frame never starts, I see the load fail and a protocol frame refusing the page later reaches no listener', async () => {
    // Given
    const { loader, timers, countMismatchListeners } = setupLoader({
      published: { doom: 'bafy-base' },
      silentSandbox: true,
    });
    await loader.load('doom');

    // When
    await timers.advance(30_000);

    // Then
    expect(countMismatchListeners()).toBe(0);
  });

  it('As a visitor on a gateway, I open an app and am shown it as trusted', async () => {
    // Given
    const { loader, debug } = setupLoader({ backend: 'rpc-gateway', published: { doom: 'bafy-base' } });

    // When
    await loader.load('doom');

    // Then
    expect(urlPillState.store.get()).toMatchObject({ kind: 'product', domain: 'doom', shield: 'trusted' });
    expect(debug.find(event => event.event === 'phase')?.payload).toEqual({
      label: 'doom',
      phase: 'asset-hub-syncing',
    });
  });

  it('As a visitor with the CID cache turned off, I open a name and it is resolved with nothing cached', async () => {
    // Given
    const { loader, cidCache, stored, frame } = setupLoader({ skipCidCache: true, published: { doom: 'bafy-base' } });

    // When
    await loader.load('doom');

    // Then
    expect(cidCache.get).not.toHaveBeenCalled();
    expect(stored).toEqual([]);
    expect(frame.render).toHaveBeenCalledWith(getRenderedDoom('bafy-base'));
  });

  it('As a visitor, I load the same name twice at once and the second load waits for the first and loads nothing more', async () => {
    // Given
    const { loader, names, frame } = setupLoader({ published: { doom: 'bafy-base' } });

    // When
    await Promise.all([loader.load('doom'), loader.load('doom')]);

    // Then
    expect(names.resolveProduct).toHaveBeenCalledTimes(1);
    expect(frame.render).toHaveBeenCalledTimes(1);
  });
});

/**
 * Builds a loader on a fresh page, with every report it sends recorded: the captures, the debug panel's events, the
 * resolution span's attributes as the trace sets them, and every distribution. Restored when the case ends.
 */
function setupLoader(params: Params = {}) {
  localStorage.clear();
  sessionStorage.clear();
  resetAllStoresForTests();
  const captured: CaptureContext[] = [];
  const debug: DotliDebugEvent[] = [];
  debugBus.enableBuffering();
  const unwatch = debugBus.watch(event => {
    if ('layer' in event) {
      debug.push(event);
    }
  });
  const unbindSink = bindCaptureSink({
    exception(_error, context) {
      captured.push(context);
    },
    expected: () => undefined,
  });
  const recording = bindRecordingSentry();
  onTestFinished(() => {
    // The load starts the page's loading screen, and the no-content case leaves a screen mounted.
    pageLoading.stopStatusTick();
    pageScreen.clear();
    recording.restore();
    unbindSink();
    unwatch();
  });
  const timers = createManualTimers();
  const failures: LoadFailure[] = [];
  const contentDone = new Set<(outcome: ContentOutcome, failedStep: string | undefined) => void>();
  const stored: string[] = [];
  const revalidated: [string, string, boolean][] = [];
  const recents: string[] = [];
  let forgotten = 0;
  const mismatchListeners = new Set<(error: ProtocolVersionMismatchError) => void>();
  const sandboxListeners = new Set<() => void>();
  const published = params.published ?? {};
  const names: NameSource = {
    resolveProduct: vi.fn((label: string, { onPhase }: Parameters<NameSource['resolveProduct']>[1] = {}) => {
      onPhase?.('asset-hub-syncing');
      return params.resolveError !== undefined
        ? Promise.reject(params.resolveError)
        : Promise.resolve(published[`app.${label}`] ?? published[label] ?? null);
    }),
    readManifests: vi.fn(() => Promise.resolve(NO_MANIFESTS)),
    readWorkerManifest: vi.fn(() => Promise.resolve(params.workerManifest ?? { kind: 'empty' as const })),
  };
  const frame = {
    setPageProduct: vi.fn(),
    render: vi.fn<LoaderFrame['render']>(() => Promise.resolve()),
    halt: vi.fn(),
    onContentDone(callback) {
      contentDone.add(callback);
      return () => {
        contentDone.delete(callback);
      };
    },
    onContentProgress: () => () => undefined,
    onSandboxHeard(listener) {
      sandboxListeners.add(listener);
      if (params.silentSandbox !== true) {
        queueMicrotask(listener);
      }
      return () => {
        sandboxListeners.delete(listener);
      };
    },
  } satisfies LoaderFrame;
  const cidCache = {
    get: vi.fn<LoaderCidCache['get']>(() => Promise.resolve(params.cached ?? null)),
    storeLater({ label, cid }) {
      stored.push(`${label} ${cid}`);
    },
    revalidateLater({ label, servedCid, onScreen }) {
      revalidated.push([label, servedCid, onScreen]);
    },
  } satisfies LoaderCidCache;
  const loader = createProductLoader({
    backend: params.backend ?? 'smoldot-direct',
    skipCidCache: params.skipCidCache ?? false,
    flowId: 'boot-1',
    startedAt: 0,
    names,
    frame,
    cidCache,
    recents: {
      record(label) {
        recents.push(label);
        return Promise.resolve();
      },
    },
    failureScreen: {
      show(failure) {
        failures.push(failure);
        if (params.failToShow !== undefined) {
          throw params.failToShow;
        }
      },
      forget() {
        forgotten += 1;
      },
    },
    onProtocolVersionMismatch(listener) {
      if (params.latchedMismatch !== undefined) {
        listener(params.latchedMismatch);
        return () => undefined;
      }
      mismatchListeners.add(listener);
      return () => {
        mismatchListeners.delete(listener);
      };
    },
    timers,
    now: timers.now,
  });
  return {
    loader,
    /** The page's clock and timers, which only the case moves. */
    timers,
    names,
    frame,
    cidCache,
    failures,
    stored,
    revalidated,
    /** The labels recorded in the recent list. */
    recents,
    captured,
    debug,
    /** Every distribution the page sent. */
    distributions: recording.distributions,
    /** Returns the resolution span's attributes as the trace last set them, or undefined before it starts. */
    readResolution: () => recording.spans.filter(span => span.name === 'dotli.resolution').at(-1)?.attributes,
    /** Returns each debug panel event as `layer:event`, in order. */
    listEvents: () => debug.map(event => `${event.layer}:${event.event}`),
    /** Returns how often the failure screen forgot the previous attempt's failure. */
    countForgotten: () => forgotten,
    /** Returns how many listeners still hear the sandbox. */
    countSandboxListeners: () => sandboxListeners.size,
    /** Returns how many callbacks still wait for the content's outcome. */
    countContentCallbacks: () => contentDone.size,
    /** Returns how many listeners still hear a protocol frame refuse this page's wire. */
    countMismatchListeners: () => mismatchListeners.size,
    /** A protocol frame rebuilt from a newer release refusing this page's wire. */
    refuseWire,
    /** The sandbox reporting its content's outcome, once. */
    reportContent,
  };

  function refuseWire(error: ProtocolVersionMismatchError): void {
    const listeners = [...mismatchListeners];
    mismatchListeners.clear();
    for (const listener of listeners) {
      listener(error);
    }
  }

  function reportContent(outcome: ContentOutcome, failedStep?: string): void {
    const callbacks = [...contentDone];
    contentDone.clear();
    for (const callback of callbacks) {
      callback(outcome, failedStep);
    }
  }
}

function createWorkerManifest(
  value: { kind: 'app' } | { kind: 'worker'; entrypoint: string; includes: { chat?: boolean } },
): ManifestResult<ExecutableManifest> {
  return { kind: 'ok', value: { $v: 1, appVersion: [1, 0, 0], ...value }, raw: '' };
}

/** The product `doom` the frame is asked to render from `cid`, with any chat flag. */
function getRenderedDoom(cid: string): Record<string, unknown> {
  const chat: unknown = expect.any(Promise);
  return { mode: 'subdomain', label: 'doom', cid, chat };
}
