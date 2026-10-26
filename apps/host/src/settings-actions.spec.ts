// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import type { Settings } from '@dotli/config';
import type { Continuation } from './continuation.js';
import {
  createSettingsActions,
  wipeOriginState,
  type SettingsActionsDeps,
  type WipeParts,
} from './settings-actions.js';
import { SMOLDOT_DB_NAME } from '@dotli/chains';
import { WALLET_DB_NAME } from '@dotli/storage';
import { memoryStorage } from '@dotli/shared/testing';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { bindLogSink, safeStorage, type OriginStores } from '@dotli/shared';

const CACHE_ON = {
  skipCidCache: false,
  skipArchiveCache: false,
  skipWorkerCache: false,
};

const prior: Settings = {
  backend: 'smoldot-direct',
  network: 'paseo-next-v2',
  cache: CACHE_ON,
};

/** The page URL the reload boots from. */
let page: { pathname: string; search: string; hash: string };

/** Fakes that record, in order, what the reset did. */
function resetDeps(): { deps: SettingsActionsDeps; steps: string[]; saved: Settings[]; reasons: Continuation[] } {
  const steps: string[] = [];
  const saved: Settings[] = [];
  const reasons: Continuation[] = [];
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
    reload: reason => {
      steps.push('reload');
      reasons.push(reason);
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
  return { deps, steps, saved, reasons };
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
    const draft: Settings = { ...prior, cache: { ...CACHE_ON, skipArchiveCache: true } };

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
    const draft: Settings = { ...prior, cache: { ...CACHE_ON, skipCidCache: true } };

    // When
    await applyAndReset(draft, prior);

    // Then
    expect(steps).toEqual(['clear dotNS cache', 'reload']);
  });

  it('As a user, I turn the archive cache back on and keep everything I had', async () => {
    // Given
    const { deps, steps } = resetDeps();
    const { applyAndReset } = createSettingsActions(deps);
    const off: Settings = { ...prior, cache: { ...CACHE_ON, skipArchiveCache: true } };

    // When
    await applyAndReset(prior, off);

    // Then
    expect(steps).toEqual(['reload']);
  });

  it('As a user, I reset everything and the other origins are asked to purge after the wipe that would drop the request', async () => {
    // Given
    const { deps, steps, saved } = resetDeps();
    const { applyAndReset } = createSettingsActions(deps);
    const draft: Settings = { ...prior, backend: 'rpc-gateway' };

    // When
    await applyAndReset(draft, prior, { forceFullWipe: true });

    // Then
    expect(steps).toEqual(['wipe origin', 'schedule protocol and sandbox purge', 'reload']);
    expect(saved.at(-1)?.backend).toBe('rpc-gateway');
  });

  it('As a user whose cache fails to clear, Save & Apply counts the failure and still reloads with my new settings', async () => {
    // Given a clear that reported its own failure and resolved false, as the real one does
    const { deps, steps, saved } = resetDeps();
    deps.clearBlockCache = () => Promise.resolve(false);
    const { applyAndReset } = createSettingsActions(deps);
    const draft: Settings = { ...prior, cache: { ...CACHE_ON, skipArchiveCache: true } };

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
    await applyAndReset({ ...prior, backend: 'rpc-gateway' }, prior, { forceFullWipe: true });

    // Then
    expect(steps).toEqual(['schedule protocol and sandbox purge', 'reload']);
    expect(saved.at(-1)?.backend).toBe('rpc-gateway');
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
    await applyAndReset({ ...prior, backend: 'rpc-gateway' }, prior, { forceFullWipe: true });

    // Then
    expect(steps).toEqual(['wipe origin', 'reload']);
    expect(saved.at(-1)?.backend).toBe('rpc-gateway');
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(captures.expected).toHaveBeenCalledWith(refused, { flow: 'storage', step: 'settings_apply' });
    expect(metrics.counted('settings.apply')).toEqual([{ outcome: 'error', reason: 'pending_reset' }]);
  });

  it('As a user whose origin wipe and purge request both fail, Clear all counts each failed step once and warns once, that the purge request was not stored', async () => {
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
    await applyAndReset({ ...prior, backend: 'rpc-gateway' }, prior, { forceFullWipe: true });

    // Then both steps are counted in order, only the purge left a breadcrumb and a warning, and the page reloads
    expect(steps).toEqual(['reload']);
    expect(metrics.counted('settings.apply')).toEqual([
      { outcome: 'error', reason: 'wipe' },
      { outcome: 'error', reason: 'pending_reset' },
    ]);
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
  });

  it('As a user whose cache clear throws where it should have resolved, Save & Apply still reloads and the fault is reported once', async () => {
    // Given a clear that rejects instead of resolving false
    const { deps, steps } = resetDeps();
    const fault = new TypeError('clear broke');
    deps.clearBlockCache = () => Promise.reject(fault);
    const { applyAndReset } = createSettingsActions(deps);

    // When
    await applyAndReset({ ...prior, cache: { ...CACHE_ON, skipArchiveCache: true } }, prior);

    // Then the page still reloads, and the fault is captured and counted beside the steps
    expect(steps).toEqual(['reload']);
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(fault, { flow: 'ui', step: 'settings_apply' });
    expect(metrics.counted('settings.apply')).toEqual([{ outcome: 'error', reason: 'fault' }]);
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

  it('As a user saving my settings, the reload tells the next boot it follows a settings change', async () => {
    // Given
    const { deps, reasons } = resetDeps();
    const { applyAndReset } = createSettingsActions(deps);

    // When
    await applyAndReset({ ...prior, network: 'previewnet' }, prior);

    // Then
    expect(reasons).toEqual(['settings_change']);
  });

  it('As a visitor switching backend from a failure screen, my choice is saved and carried in the URL, nothing is wiped and the reload says why', async () => {
    // Given
    const { deps, steps, saved, reasons } = resetDeps();
    const { applyAndReset } = createSettingsActions(deps);

    // When
    await applyAndReset({ ...prior, backend: 'rpc-gateway' }, prior, { reason: 'switch_backend' });

    // Then
    expect(steps).toEqual(['reload']);
    expect(saved).toEqual([{ ...prior, backend: 'rpc-gateway' }]);
    expect(page.search).toBe('?chainBackend=rpc-gateway');
    expect(reasons).toEqual(['switch_backend']);
  });
});

describe('full reset', () => {
  let local: Storage;
  let session: Storage;

  /** A browser with none of the stores a wipe empties, over this test's storages, unless `stores` adds them. */
  function parts(stores: Partial<OriginStores> = {}): WipeParts {
    return {
      stores: { indexedDB: null, caches: null, serviceWorker: null, ...stores },
      local: safeStorage(() => local),
      session: safeStorage(() => session),
    };
  }

  /** A database list whose every delete the browser refuses, as `deleteDatabase` fires `error`. */
  function refusingDatabases(names: string[]): OriginStores['indexedDB'] {
    return {
      databases: () => Promise.resolve(names.map(name => ({ name, version: 1 }))),
      deleteDatabase: () => {
        const request = { error: new DOMException('refused', 'UnknownError') } as unknown as IDBOpenDBRequest;
        queueMicrotask(() => {
          request.onerror?.call(request, new Event('error'));
        });
        return request;
      },
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

  it("As a user on the landing page, I wipe its origin and the frame's session, settings and wallet stay", async () => {
    // Given the frame's keys and databases beside the page's own
    local.setItem('TRUAPI_dot.li_session', 'signed-in');
    local.setItem('DOTLI_MODE_dot.li_x', 'smoldot');
    local.setItem('dotli:network', 'paseo');
    const deleted: string[] = [];
    const indexedDB: OriginStores['indexedDB'] = {
      databases: () => Promise.resolve(['dotli', WALLET_DB_NAME, SMOLDOT_DB_NAME].map(name => ({ name, version: 1 }))),
      deleteDatabase: name => {
        deleted.push(name);
        const request = {} as IDBOpenDBRequest;
        queueMicrotask(() => {
          request.onsuccess?.call(request, new Event('success'));
        });
        return request;
      },
    };

    // When the origin is wiped
    await wipeOriginState(parts({ indexedDB }));

    // Then only the page's own data went
    expect(local.getItem('TRUAPI_dot.li_session')).toBe('signed-in');
    expect(local.getItem('DOTLI_MODE_dot.li_x')).toBe('smoldot');
    expect(local.getItem('dotli:network')).toBeNull();
    expect(deleted).toEqual(['dotli']);
  });

  it("As a user on the landing page, I wipe its origin and the wipe never writes the frame's keys", async () => {
    // Given the frame's keys and a page key in a storage that records its writes
    local.setItem('TRUAPI_dot.li_session', 'signed-in');
    local.setItem('DOTLI_MODE_dot.li_x', 'smoldot');
    local.setItem('dotli:network', 'paseo');
    const base = safeStorage(() => local);
    const calls: string[] = [];
    const recording: WipeParts['local'] = {
      ...base,
      setItem: (key, value) => {
        calls.push(`setItem ${key}`);
        base.setItem(key, value);
      },
      removeItem: key => {
        calls.push(`removeItem ${key}`);
        base.removeItem(key);
      },
      clear: () => {
        calls.push('clear');
        base.clear();
      },
    };

    // When the origin is wiped
    await wipeOriginState({ ...parts(), local: recording });

    // Then nothing cleared the storage or touched a frame key, and only the page's key went
    expect(calls).not.toContain('clear');
    expect(calls.filter(call => /^(setItem|removeItem) (TRUAPI_|DOTLI_MODE_)/.test(call))).toEqual([]);
    expect(local.getItem('TRUAPI_dot.li_session')).toBe('signed-in');
    expect(local.getItem('DOTLI_MODE_dot.li_x')).toBe('smoldot');
    expect(local.getItem('dotli:network')).toBeNull();
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

  it('As an operator, a database the browser refuses to delete is reported as an expected failure, counted and named to the caller, and the other parts still run', async () => {
    // Given a database whose delete fails, and a reporting pipeline that records
    const ran: string[] = [];
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    local.setItem('dotli:network', 'paseo');

    // When
    const failed = await wipeOriginState(
      parts({
        indexedDB: refusingDatabases(['dotli']),
        caches: {
          keys: () => Promise.resolve(['shell']),
          delete: () => {
            ran.push('cache storage');
            return Promise.resolve(true);
          },
        },
        serviceWorker: {
          getRegistrations: () =>
            Promise.resolve([
              {
                unregister: () => {
                  ran.push('service workers');
                  return Promise.resolve(true);
                },
              } as unknown as ServiceWorkerRegistration,
            ]),
        },
      }),
    );

    // Then the failed part is named, reported and counted, and the rest of the wipe ran
    expect(failed).toEqual(['indexeddb']);
    expect(ran).toEqual(['cache storage', 'service workers']);
    expect(local.getItem('dotli:network')).toBeNull();
    expect(captures.expected).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Failed to delete dotli DB: UnknownError' }),
      { flow: 'storage', step: 'origin_wipe_indexeddb' },
    );
    expect(captures.exception).not.toHaveBeenCalled();
    expect(metrics.counted('settings.origin_wipe')).toEqual([{ outcome: 'error', reason: 'indexeddb' }]);
  });
});
