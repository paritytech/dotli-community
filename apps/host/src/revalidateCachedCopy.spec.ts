// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createDeferred } from '@dotli/shared';
import type { CachedManifests } from '@dotli/storage';
import type { ShowNotification } from '@dotli/ui';
import { revalidateCachedCopy, type RevalidateCachedCopyParams } from './revalidateCachedCopy.js';
import type { ProductManifests } from './cachedManifest.js';
import { createNameSource, type NameSource } from './createNameSource.js';

type Notice = Parameters<ShowNotification>[0];

/** What the page hands a revalidation besides the copy it checks. */
type RevalidationParams = Omit<RevalidateCachedCopyParams, 'label' | 'servedCid' | 'onScreen'>;

/** A revalidation's page, recording what it wrote, dropped, showed and captured until the case ends. */
type RevalidationRig = {
  params: RevalidationParams;
  written: { label: string; cid: string; manifests: CachedManifests }[];
  evicted: string[];
  notices: Notice[];
  captured: CaptureContext[];
  reload: Mock;
  /** Resolves once the page first shows a notice. */
  noticed: Promise<void>;
  /** Resolves once the page reloads. */
  reloaded: Promise<void>;
};

type Published = Record<string, string> | Error;

type CreatePublishedNameSourceParams = {
  /** Contenthashes by name, or the error every lookup rejects with. */
  published: Published;
};

type SetupRevalidationParams = {
  /** Contenthashes by name, or the error every lookup rejects with. */
  published: Published;
  /** Whether dropping a cached entry works, true by default. */
  evictWorks?: boolean;
};

/** A revalidation whose new manifests arrive only when the case hands them over. */
type ReadingRevalidation = {
  /** Hands the manifests over and resolves once the revalidation is done. */
  finish: (manifests: ProductManifests) => Promise<void>;
};

describe('revalidateCachedCopy', () => {
  it('As a visitor on a cached app that has not changed, I am left alone and the cache is not touched', async () => {
    // Given
    const { params, written, evicted, notices, reload } = setupRevalidation({ published: { doom: 'bafy-served' } });

    // When
    await revalidateCachedCopy({ label: 'doom', servedCid: 'bafy-served', onScreen: true, ...params });

    // Then
    expect(written).toEqual([]);
    expect(evicted).toEqual([]);
    expect(notices).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('As a visitor on a cached app that was redeployed, I am offered a reload onto it and the cache keeps the new version', async () => {
    // Given
    const { params, written, notices, reload, reloaded } = setupRevalidation({ published: { doom: 'bafy-latest' } });

    // When
    await revalidateCachedCopy({ label: 'doom', servedCid: 'bafy-served', onScreen: true, ...params });
    notices[0]?.action?.onClick();
    await reloaded;

    // Then
    expect(written).toEqual([{ label: 'doom', cid: 'bafy-latest', manifests: { root: null, app: null, owner: null } }]);
    expect(notices.map(notice => notice.label)).toEqual(['New version available']);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('As a visitor, I press Reload while the new version is still being cached and the reload waits for it', async () => {
    // Given the visitor was offered the new version before its manifests arrived
    const rig = setupRevalidation({ published: { doom: 'bafy-latest' } });
    const reading = await offerWhileReading(rig);

    // When
    rig.notices[0]?.action?.onClick();

    // Then
    expect(rig.notices.map(notice => notice.label)).toEqual(['New version available']);
    expect(rig.reload).not.toHaveBeenCalled();

    // When
    await reading.finish({ root: { kind: 'empty' }, app: { kind: 'empty' }, owner: null });

    // Then
    expect(rig.written).toEqual([
      { label: 'doom', cid: 'bafy-latest', manifests: { root: null, app: null, owner: null } },
    ]);
    expect(rig.reload).toHaveBeenCalledOnce();
  });

  it('As a visitor, I press Reload onto a redeploy this host refuses and am reloaded once onto the screen that says why', async () => {
    // Given
    const rig = setupRevalidation({ published: { doom: 'bafy-latest' } });
    const reading = await offerWhileReading(rig);
    rig.notices[0]?.action?.onClick();

    // When the app manifest turns out unreadable
    await reading.finish({ root: { kind: 'empty' }, app: { kind: 'invalid', errors: ['unreadable'], raw: '{}' } });

    // Then
    expect(rig.notices.map(notice => notice.label)).toEqual(['New version available']);
    expect(rig.evicted).toEqual(['doom']);
    expect(rig.reload).toHaveBeenCalledOnce();
  });

  it('As a visitor on a cached app published under its app subname, I come back and am left alone while the base name points elsewhere', async () => {
    // Given
    const { params, written, evicted, notices, reload } = setupRevalidation({
      published: { 'app.doom': 'bafy-app', doom: 'bafy-base' },
    });

    // When
    await revalidateCachedCopy({ label: 'doom', servedCid: 'bafy-app', onScreen: true, ...params });

    // Then
    expect(written).toEqual([]);
    expect(evicted).toEqual([]);
    expect(notices).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('As a visitor on a cached app only its app subname publishes, I come back and keep it on screen rather than reloading', async () => {
    // Given
    const { params, evicted, reload } = setupRevalidation({ published: { 'app.doom': 'bafy-app' } });

    // When
    await revalidateCachedCopy({ label: 'doom', servedCid: 'bafy-app', onScreen: true, ...params });

    // Then
    expect(evicted).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('As a visitor on a cached app whose name was cleared, I come back and am reloaded onto the cold path, which says why', async () => {
    // Given
    const { params, evicted, reload } = setupRevalidation({ published: {} });

    // When
    await revalidateCachedCopy({ label: 'doom', servedCid: 'bafy-served', onScreen: true, ...params });

    // Then
    expect(evicted).toEqual(['doom']);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('As a visitor on a cached app whose name was cleared, I come back while the stale copy cannot be dropped and stay on it, so no reload loop starts', async () => {
    // Given an evict that fails
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { params, reload } = setupRevalidation({ published: {}, evictWorks: false });

    // When
    await revalidateCachedCopy({ label: 'doom', servedCid: 'bafy-served', onScreen: true, ...params });

    // Then
    expect(reload).not.toHaveBeenCalled();
    expect(metrics.counted('cache.revalidate')).toEqual([
      expect.objectContaining({ outcome: 'error', reason: 'evict_failed' }),
    ]);
  });

  it('As a visitor shown why a cached copy was refused, I stay on that screen and the stale entry is dropped', async () => {
    // Given
    const { params, evicted, reload } = setupRevalidation({ published: {} });

    // When
    await revalidateCachedCopy({ label: 'doom', servedCid: 'bafy-served', onScreen: false, ...params });

    // Then
    expect(evicted).toEqual(['doom']);
    expect(reload).not.toHaveBeenCalled();
  });

  it('As an operator, I see a revalidation that failed reported, and the visitor keeps the cached app', async () => {
    // Given
    const { params, written, evicted, captured, reload } = setupRevalidation({
      published: new Error('hub unreachable'),
    });

    // When
    await revalidateCachedCopy({ label: 'doom', servedCid: 'bafy-served', onScreen: true, ...params });

    // Then
    expect(captured).toMatchObject([{ step: 'cache_revalidate' }]);
    expect(written).toEqual([]);
    expect(evicted).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('As an operator, I watch four revalidations and each is counted under one name, tagged with what it found', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const unchanged = setupRevalidation({ published: { doom: 'bafy-served' } });
    const redeployed = setupRevalidation({ published: { doom: 'bafy-latest' } });
    const cleared = setupRevalidation({ published: {} });
    const unreachable = setupRevalidation({ published: new Error('Asset Hub went quiet') });

    // When
    await revalidateCachedCopy({ label: 'doom', servedCid: 'bafy-served', onScreen: true, ...unchanged.params });
    await revalidateCachedCopy({ label: 'doom', servedCid: 'bafy-served', onScreen: true, ...redeployed.params });
    await revalidateCachedCopy({ label: 'doom', servedCid: 'bafy-served', onScreen: false, ...cleared.params });
    await revalidateCachedCopy({ label: 'doom', servedCid: 'bafy-served', onScreen: true, ...unreachable.params });

    // Then
    expect(metrics.counted('cache.revalidate')).toEqual([
      expect.objectContaining({ outcome: 'match' }),
      expect.objectContaining({ outcome: 'update' }),
      expect.objectContaining({ outcome: 'cleared' }),
      expect.objectContaining({ outcome: 'error' }),
    ]);
  });
});

/** Returns the light client's resolver over what is published, so the name source's own lookup order is what runs. */
function createPublishedNameSource({ published }: CreatePublishedNameSourceParams): NameSource {
  return createNameSource({
    backend: 'smoldot-direct',
    remote: {
      resolveDotName: name =>
        published instanceof Error ? Promise.reject(published) : Promise.resolve(published[name] ?? null),
      resolveOwner: () => Promise.resolve(null),
      resolveRootManifest: () => Promise.resolve({ kind: 'empty' }),
      resolveExecutableManifest: () => Promise.resolve({ kind: 'empty' }),
    },
    loadRpc: () => Promise.reject(new Error('a light client load reads no gateway')),
  });
}

/** Builds a revalidation's page over what is published, with a capture sink bound until the case ends. */
function setupRevalidation({ published, evictWorks = true }: SetupRevalidationParams): RevalidationRig {
  const written: RevalidationRig['written'] = [];
  const evicted: string[] = [];
  const notices: Notice[] = [];
  const captured: CaptureContext[] = [];
  const noticed = createDeferred<undefined>();
  const reloaded = createDeferred<undefined>();
  const reload = vi.fn(() => {
    reloaded.resolve(undefined);
  });
  onTestFinished(
    bindCaptureSink({
      exception(_error, context) {
        captured.push(context);
      },
      expected: () => undefined,
    }),
  );
  return {
    params: {
      names: createPublishedNameSource({ published }),
      cache: {
        set(copy) {
          written.push(copy);
          return Promise.resolve();
        },
        evict(label) {
          evicted.push(label);
          return Promise.resolve(evictWorks);
        },
      },
      notify(notice) {
        notices.push(notice);
        noticed.resolve(undefined);
      },
      reload,
    },
    written,
    evicted,
    notices,
    captured,
    reload,
    noticed: noticed.promise,
    reloaded: reloaded.promise,
  };
}

/** Revalidates a redeployed copy whose new manifests arrive only when the case hands them over, once it is offered. */
async function offerWhileReading(rig: RevalidationRig): Promise<ReadingRevalidation> {
  const manifests = createDeferred<ProductManifests>();
  const revalidated = revalidateCachedCopy({
    label: 'doom',
    servedCid: 'bafy-served',
    onScreen: true,
    ...rig.params,
    names: { ...rig.params.names, readManifests: () => manifests.promise },
  });
  await rig.noticed;
  return {
    async finish(read) {
      manifests.resolve(read);
      await revalidated;
    },
  };
}
