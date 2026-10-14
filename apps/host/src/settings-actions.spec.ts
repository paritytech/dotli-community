// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import {
  createSettingsActions,
  wipeOriginState,
  type ModeDraft,
  type SettingsActionsDeps,
  type WipeParts,
} from './settings-actions.js';
import { memoryStorage } from '@dotli/shared/testing';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { bindLogSink } from '@dotli/shared';

const CACHE_ON = {
  skipCidCache: false,
  skipArchiveCache: false,
  skipWorkerCache: false,
};

const prior: ModeDraft = {
  chain: 'smoldot-direct',
  network: 'paseo-next-v2',
  cache: CACHE_ON,
};

/** The page URL the reload boots from. */
let page: { pathname: string; search: string; hash: string };

/** Fakes that record, in order, what the reset did. */
function resetDeps(): { deps: SettingsActionsDeps; steps: string[]; saved: ModeDraft[] } {
  const steps: string[] = [];
  const saved: ModeDraft[] = [];
  const deps: SettingsActionsDeps = {
    clearCidCache: () => {
      steps.push('clear dotNS cache');
      return Promise.resolve(true);
    },
    clearBlockCache: () => {
      steps.push('clear archive cache');
      return Promise.resolve(true);
    },
    wipeOrigin: () => {
      steps.push('wipe origin');
      return Promise.resolve([]);
    },
    schedulePendingReset: targets => {
      steps.push(`schedule ${targets.join(' and ')} purge`);
    },
    reload: () => {
      steps.push('reload');
    },
    save: draft => {
      saved.push(draft);
    },
    url: {
      read: () => page,
      replace: url => {
        const next = new URL(url, 'http://localhost');
        page = { pathname: next.pathname, search: next.search, hash: next.hash };
      },
    },
  };
  return { deps, steps, saved };
}

describe('applyAndReset', () => {
  const captures = { exception: vi.fn(), expected: vi.fn() };
  let metrics: RecordingSentry;
  let unbindCaptures: () => void;

  beforeEach(() => {
    page = { pathname: '/', search: '', hash: '' };
    metrics = bindRecordingSentry({ onFinished: onTestFinished });
    unbindCaptures = bindCaptureSink(captures);
  });

  afterEach(() => {
    unbindCaptures();
    vi.clearAllMocks();
  });

  it('As a user, I turn the archive cache off and the blocks the host kept are cleared before the reload', async () => {
    // Given
    const { deps, steps, saved } = resetDeps();
    const { applyAndReset } = createSettingsActions(deps);
    const draft: ModeDraft = { ...prior, cache: { ...CACHE_ON, skipArchiveCache: true } };

    // When
    await applyAndReset(draft, prior);

    // Then the sandbox, which holds nothing across reloads, is not asked to purge
    expect(steps).toEqual(['clear archive cache', 'reload']);
    expect(saved.at(-1)?.cache.skipArchiveCache).toBe(true);
  });

  it('As a user, I turn the dotNS cache off and the cached names are cleared before the reload', async () => {
    // Given
    const { deps, steps } = resetDeps();
    const { applyAndReset } = createSettingsActions(deps);
    const draft: ModeDraft = { ...prior, cache: { ...CACHE_ON, skipCidCache: true } };

    // When
    await applyAndReset(draft, prior);

    // Then
    expect(steps).toEqual(['clear dotNS cache', 'reload']);
  });

  it('As a user, I turn the archive cache back on and keep everything I had', async () => {
    // Given
    const { deps, steps } = resetDeps();
    const { applyAndReset } = createSettingsActions(deps);
    const off: ModeDraft = { ...prior, cache: { ...CACHE_ON, skipArchiveCache: true } };

    // When
    await applyAndReset(prior, off);

    // Then
    expect(steps).toEqual(['reload']);
  });

  it('As a user, I reset everything and the other origins are asked to purge after the wipe that would drop the request', async () => {
    // Given
    const { deps, steps, saved } = resetDeps();
    const { applyAndReset } = createSettingsActions(deps);
    const draft: ModeDraft = { ...prior, chain: 'rpc-gateway' };

    // When
    await applyAndReset(draft, prior, { forceFullWipe: true });

    // Then
    expect(steps).toEqual(['wipe origin', 'schedule protocol and sandbox purge', 'reload']);
    expect(saved.at(-1)?.chain).toBe('rpc-gateway');
  });

  it('As a user whose cache fails to clear, Save & Apply counts the failure and still reloads with my new settings', async () => {
    // Given a clear that reported its own failure and resolved false, as the real one does
    const { deps, steps, saved } = resetDeps();
    deps.clearBlockCache = () => Promise.resolve(false);
    const { applyAndReset } = createSettingsActions(deps);
    const draft: ModeDraft = { ...prior, cache: { ...CACHE_ON, skipArchiveCache: true } };

    // When
    await applyAndReset(draft, prior);

    // Then: the reload boots with the new settings, from storage and from the URL alike
    expect(steps).toEqual(['reload']);
    expect(saved.at(-1)?.cache.skipArchiveCache).toBe(true);
    expect(new URLSearchParams(page.search).get('skipArchiveCache')).toBe('1');
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).not.toHaveBeenCalled();
    expect(metrics.counted('settings.apply')).toEqual([{ outcome: 'error', reason: 'block_cache' }]);
  });

  it('As a user whose dotNS cache fails to clear, Save & Apply counts it against that cache', async () => {
    // Given
    const { deps } = resetDeps();
    deps.clearCidCache = () => Promise.resolve(false);
    const { applyAndReset } = createSettingsActions(deps);

    // When
    await applyAndReset({ ...prior, cache: { ...CACHE_ON, skipCidCache: true } }, prior);

    // Then
    expect(metrics.counted('settings.apply')).toEqual([{ outcome: 'error', reason: 'cid_cache' }]);
  });

  it('As a user whose origin wipe leaves something behind, Clear all counts it and still applies and reloads', async () => {
    // Given a wipe that reported its own failed parts
    const { deps, steps, saved } = resetDeps();
    deps.wipeOrigin = () => Promise.resolve(['indexeddb']);
    const { applyAndReset } = createSettingsActions(deps);

    // When
    await applyAndReset({ ...prior, chain: 'rpc-gateway' }, prior, { forceFullWipe: true });

    // Then
    expect(steps).toEqual(['schedule protocol and sandbox purge', 'reload']);
    expect(saved.at(-1)?.chain).toBe('rpc-gateway');
    expect(captures.exception).not.toHaveBeenCalled();
    expect(metrics.counted('settings.apply')).toEqual([{ outcome: 'error', reason: 'wipe' }]);
  });

  it('As a user without session storage, Clear all still wipes, applies and reloads, and the purge request is left as a breadcrumb', async () => {
    // Given
    const { deps, steps, saved } = resetDeps();
    const refused = new Error('Pending reset not scheduled');
    deps.schedulePendingReset = () => {
      throw refused;
    };
    const { applyAndReset } = createSettingsActions(deps);

    // When
    await applyAndReset({ ...prior, chain: 'rpc-gateway' }, prior, { forceFullWipe: true });

    // Then
    expect(steps).toEqual(['wipe origin', 'reload']);
    expect(saved.at(-1)?.chain).toBe('rpc-gateway');
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(captures.expected).toHaveBeenCalledWith(refused, { flow: 'storage', step: 'settings_apply' });
    expect(metrics.counted('settings.apply')).toEqual([{ outcome: 'error', reason: 'pending_reset' }]);
  });

  it('As a user whose origin wipe and purge request both fail, Clear all counts each failed step once and warns only of the purge', async () => {
    // Given a wipe that left something behind, and no session storage for the purge request
    const { deps, steps } = resetDeps();
    deps.wipeOrigin = () => Promise.resolve(['indexeddb']);
    const refused = new Error('Pending reset not scheduled');
    deps.schedulePendingReset = () => {
      throw refused;
    };
    const warnings: string[] = [];
    onTestFinished(
      bindLogSink({
        emit: (level, message) => {
          if (level === 'warn') {
            warnings.push(message);
          }
        },
      }),
    );
    const { applyAndReset } = createSettingsActions(deps);

    // When
    await applyAndReset({ ...prior, chain: 'rpc-gateway' }, prior, { forceFullWipe: true });

    // Then both steps are counted in order, only the purge left a breadcrumb and a warning, and the page reloads
    expect(steps).toEqual(['reload']);
    expect(metrics.counted('settings.apply')).toEqual([
      { outcome: 'error', reason: 'wipe' },
      { outcome: 'error', reason: 'pending_reset' },
    ]);
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual(['[dot.li settings] purge request not stored: Pending reset not scheduled']);
  });

  it('As a user whose cache clear throws where it should have resolved, Save & Apply still reloads and the fault is reported once', async () => {
    // Given a clear that rejects instead of resolving false
    const { deps, steps } = resetDeps();
    const fault = new TypeError('clear broke');
    deps.clearBlockCache = () => Promise.reject(fault);
    const { applyAndReset } = createSettingsActions(deps);

    // When
    await applyAndReset({ ...prior, cache: { ...CACHE_ON, skipArchiveCache: true } }, prior);

    // Then the page still reloads, and the fault is captured and counted by its name
    expect(steps).toEqual(['reload']);
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(fault, { flow: 'ui', step: 'settings_apply' });
    expect(metrics.counted('settings.apply')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
  });

  it('As an operator, I see a Save & Apply that cleared what it had to counted as ok', async () => {
    // Given
    const { deps } = resetDeps();
    const { applyAndReset } = createSettingsActions(deps);

    // When
    await applyAndReset({ ...prior, cache: { ...CACHE_ON, skipCidCache: true } }, prior);

    // Then
    expect(metrics.counted('settings.apply')).toEqual([{ outcome: 'ok' }]);
    expect(captures.exception).not.toHaveBeenCalled();
  });
});

describe('full reset', () => {
  let local: Storage;
  let session: Storage;

  /** Every part succeeds, over this test's storages. */
  function parts(overrides: Partial<WipeParts> = {}): WipeParts {
    return {
      indexedDb: () => Promise.resolve(),
      cacheStorage: () => Promise.resolve(),
      serviceWorkers: () => Promise.resolve(),
      local,
      session,
      ...overrides,
    };
  }

  beforeEach(() => {
    local = memoryStorage();
    session = memoryStorage({ 'dotli:continuation': 'settings_change' });
  });

  it('As a dotli user, resetting my settings keeps the colour scheme I chose', async () => {
    // Given
    local.setItem('dotli-theme', 'light');
    local.setItem('dotli:network', 'paseo');

    // When
    await wipeOriginState(parts());

    // Then the theme survives the wipe, so callers no longer snapshot it themselves
    expect(local.getItem('dotli-theme')).toBe('light');
    expect(local.getItem('dotli:network')).toBeNull();
    expect(session.length).toBe(0);
  });

  it('As a dotli user who never picked a theme, the reset does not invent one', async () => {
    // Given
    local.setItem('dotli:network', 'paseo');

    // When
    await wipeOriginState(parts());

    // Then
    expect(local.getItem('dotli-theme')).toBeNull();
    expect(local.getItem('dotli:network')).toBeNull();
  });

  it('As an operator, a wipe part that fails is reported as an expected failure, counted and named to the caller, and the other parts still run', async () => {
    // Given an IndexedDB wipe that fails, and a reporting pipeline that records
    const failure = new Error('blocked');
    const ran: string[] = [];
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    local.setItem('dotli:network', 'paseo');

    // When
    const failed = await wipeOriginState(
      parts({
        indexedDb: () => Promise.reject(failure),
        cacheStorage: () => {
          ran.push('cache storage');
          return Promise.resolve();
        },
        serviceWorkers: () => {
          ran.push('service workers');
          return Promise.resolve();
        },
      }),
    );

    // Then the failed part is named, reported and counted, and the rest of the wipe ran
    expect(failed).toEqual(['indexeddb']);
    expect(ran).toEqual(['cache storage', 'service workers']);
    expect(local.getItem('dotli:network')).toBeNull();
    expect(captures.expected).toHaveBeenCalledWith(failure, { flow: 'storage', step: 'origin_wipe_indexeddb' });
    expect(captures.exception).not.toHaveBeenCalled();
    expect(metrics.counted('settings.origin_wipe')).toEqual([{ outcome: 'error', reason: 'indexeddb' }]);
  });
});
