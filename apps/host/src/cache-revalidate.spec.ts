// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import type { CachedManifests } from '@dotli/storage';
import type { ShowNotification } from '@dotli/ui';
import { revalidateCachedCopy, type CacheRevalidationDeps } from './cache-revalidate.js';
import { revalidateCachedProduct } from './manifest-gate.js';
import type { NameSource } from './name-source.js';

type Notice = Parameters<ShowNotification>[0];

/** A name with no manifests, which any host can open. */
const NO_MANIFESTS = { root: { kind: 'empty' as const }, app: { kind: 'empty' as const } };

/** Reads names from what is published, as the name source does over either backend. */
function nameSource(published: Record<string, string> | Error): NameSource {
  const resolveName = (name: string): Promise<string | null> =>
    published instanceof Error ? Promise.reject(published) : Promise.resolve(published[name] ?? null);
  return {
    resolveProduct: async label => (await resolveName(`app.${label}`)) ?? resolveName(label),
    readManifests: () => Promise.resolve(NO_MANIFESTS),
    readWorkerManifest: () => Promise.resolve({ kind: 'empty' }),
  };
}

function setup(published: Record<string, string> | Error): {
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
      decide: revalidateCachedProduct,
      cache: {
        set: (label, cid, manifests) => {
          written.push({ label, cid, manifests });
          return Promise.resolve();
        },
        evict: label => {
          evicted.push(label);
          return Promise.resolve();
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
});
