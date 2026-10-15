// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import type { CachedManifests } from '@dotli/storage';
import type { ShowNotification } from '@dotli/ui';
import { revalidateCachedCopy, type CacheRevalidationDeps } from './cache-revalidate.js';
import { createNameSource, type NameSource } from './name-source.js';

type Notice = Parameters<ShowNotification>[0];

/** The light client's resolver over what is published, so the name source's own lookup order is what runs. */
function nameSource(published: Record<string, string> | Error): NameSource {
  return createNameSource({
    backend: 'smoldot-direct',
    remote: {
      resolveDotName: name =>
        published instanceof Error ? Promise.reject(published) : Promise.resolve(published[name] ?? null),
      resolveRootManifest: () => Promise.resolve({ kind: 'empty' }),
      resolveExecutableManifest: () => Promise.resolve({ kind: 'empty' }),
    },
    loadRpc: () => Promise.reject(new Error('a light client load reads no gateway')),
  });
}

function setup(
  published: Record<string, string> | Error,
  evictWorks = true,
): {
  deps: CacheRevalidationDeps;
  written: { label: string; cid: string; manifests: CachedManifests }[];
  evicted: string[];
  notices: Notice[];
  reload: ReturnType<typeof vi.fn>;
} {
  const written: { label: string; cid: string; manifests: CachedManifests }[] = [];
  const evicted: string[] = [];
  const notices: Notice[] = [];
  const reload = vi.fn();
  return {
    deps: {
      names: nameSource(published),
      cache: {
        set: (label, cid, manifests) => {
          written.push({ label, cid, manifests });
          return Promise.resolve();
        },
        evict: label => {
          evicted.push(label);
          return Promise.resolve(evictWorks);
        },
      },
      notify: notice => {
        notices.push(notice);
      },
      reload,
    },
    written,
    evicted,
    notices,
    reload,
  };
}

describe('revalidateCachedCopy', () => {
  const captured: CaptureContext[] = [];
  let unbind: () => void;

  beforeEach(() => {
    captured.length = 0;
    unbind = bindCaptureSink({
      exception: (_err, ctx) => {
        captured.push(ctx);
      },
      expected: () => undefined,
    });
  });

  afterEach(() => {
    unbind();
  });

  it('As a visitor on a cached app that has not changed, I am left alone and the cache is not touched', async () => {
    // Given
    const { deps, written, evicted, notices, reload } = setup({ doom: 'bafy-served' });

    // When
    await revalidateCachedCopy('doom', 'bafy-served', true, deps);

    // Then
    expect(written).toEqual([]);
    expect(evicted).toEqual([]);
    expect(notices).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('As a visitor on a cached app that was redeployed, I am offered a reload onto it and the cache keeps the new version', async () => {
    // Given
    const { deps, written, notices, reload } = setup({ doom: 'bafy-latest' });

    // When
    await revalidateCachedCopy('doom', 'bafy-served', true, deps);
    notices[0]?.action?.onClick();

    // Then
    expect(written).toEqual([{ label: 'doom', cid: 'bafy-latest', manifests: { root: null, app: null } }]);
    expect(notices.map(notice => notice.label)).toEqual(['New version available']);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('As a visitor on a cached app published under its app subname, I am left alone while the base name points elsewhere', async () => {
    // Given
    const { deps, written, evicted, notices, reload } = setup({ 'app.doom': 'bafy-app', doom: 'bafy-base' });

    // When
    await revalidateCachedCopy('doom', 'bafy-app', true, deps);

    // Then
    expect(written).toEqual([]);
    expect(evicted).toEqual([]);
    expect(notices).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('As a visitor on a cached app only its app subname publishes, I keep it on screen rather than reloading', async () => {
    // Given
    const { deps, evicted, reload } = setup({ 'app.doom': 'bafy-app' });

    // When
    await revalidateCachedCopy('doom', 'bafy-app', true, deps);

    // Then
    expect(evicted).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('As a visitor on a cached app whose name was cleared, I am reloaded onto the cold path, which says why', async () => {
    // Given
    const { deps, evicted, reload } = setup({});

    // When
    await revalidateCachedCopy('doom', 'bafy-served', true, deps);

    // Then
    expect(evicted).toEqual(['doom']);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('As a visitor on a cached app whose name was cleared, I stay on it when the stale copy cannot be dropped, so no reload loop starts', async () => {
    // Given an evict that fails
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { deps, reload } = setup({}, false);

    // When
    await revalidateCachedCopy('doom', 'bafy-served', true, deps);

    // Then
    expect(reload).not.toHaveBeenCalled();
    expect(metrics.counted('cache.revalidate')).toEqual([
      expect.objectContaining({ outcome: 'error', reason: 'evict_failed' }),
    ]);
  });

  it('As a visitor shown why a cached copy was refused, I stay on that screen while the stale entry is dropped', async () => {
    // Given
    const { deps, evicted, reload } = setup({});

    // When
    await revalidateCachedCopy('doom', 'bafy-served', false, deps);

    // Then
    expect(evicted).toEqual(['doom']);
    expect(reload).not.toHaveBeenCalled();
  });

  it('As the operator, I see a revalidation that failed reported, and the visitor keeps the cached app', async () => {
    // Given
    const { deps, written, evicted, reload } = setup(new Error('hub unreachable'));

    // When
    await revalidateCachedCopy('doom', 'bafy-served', true, deps);

    // Then
    expect(captured).toEqual([
      expect.objectContaining({ flow: 'resolve', step: 'cache_revalidate' }) as CaptureContext,
    ]);
    expect(written).toEqual([]);
    expect(evicted).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('As the operator, I see every revalidation counted under one name, tagged with what it found', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const unchanged = setup({ doom: 'bafy-served' });
    const redeployed = setup({ doom: 'bafy-latest' });
    const cleared = setup({});
    const unreachable = setup(new Error('Asset Hub went quiet'));

    // When
    await revalidateCachedCopy('doom', 'bafy-served', true, unchanged.deps);
    await revalidateCachedCopy('doom', 'bafy-served', true, redeployed.deps);
    await revalidateCachedCopy('doom', 'bafy-served', false, cleared.deps);
    await revalidateCachedCopy('doom', 'bafy-served', true, unreachable.deps);

    // Then
    expect(metrics.counted('cache.revalidate')).toEqual([
      expect.objectContaining({ outcome: 'match' }),
      expect.objectContaining({ outcome: 'update' }),
      expect.objectContaining({ outcome: 'cleared' }),
      expect.objectContaining({ outcome: 'error' }),
    ]);
  });
});
