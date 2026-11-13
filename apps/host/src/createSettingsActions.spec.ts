// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import type { Settings } from '@dotli/config';
import type { Continuation } from './createContinuation.js';
import { createSettingsActions, type SettingsActionsParams } from './createSettingsActions.js';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { bindLogSink, createDeferred } from '@dotli/shared';
import type { WipeFailure } from './wipeOriginState.js';

/** The page URL the reload boots from. */
type Page = { pathname: string; search: string; hash: string };

/** Fakes that record, in order, what the reset did, and the sinks its failures reach until the case ends. */
type ResetStand = {
  params: SettingsActionsParams;
  steps: string[];
  saved: Settings[];
  reasons: Continuation[];
  captures: { exception: Mock; expected: Mock };
  metrics: RecordingSentry;
  /** Returns the page URL as the reset left it. */
  readPage: () => Page;
};

const CACHE_ON = {
  skipCidCache: false,
  skipArchiveCache: false,
  skipWorkerCache: false,
};

const PRIOR: Settings = {
  backend: 'smoldot-direct',
  network: 'paseo-next-v2',
  cache: CACHE_ON,
};

describe('applyAndReset', () => {
  it('As a user, I turn the archive cache off and the blocks the host kept are cleared before the reload', async () => {
    // Given
    const { params, steps, saved } = setupReset();
    const { applyAndReset } = createSettingsActions(params);
    const draft: Settings = { ...PRIOR, cache: { ...CACHE_ON, skipArchiveCache: true } };

    // When
    await applyAndReset(draft, PRIOR);

    // Then the sandbox, which holds nothing across reloads, is not asked to purge
    expect(steps).toEqual(['clear archive cache', 'reload']);
    expect(saved.at(-1)?.cache.skipArchiveCache).toBe(true);
  });

  it('As a user, I turn the dotNS cache off and the cached names are cleared before the reload', async () => {
    // Given
    const { params, steps } = setupReset();
    const { applyAndReset } = createSettingsActions(params);
    const draft: Settings = { ...PRIOR, cache: { ...CACHE_ON, skipCidCache: true } };

    // When
    await applyAndReset(draft, PRIOR);

    // Then
    expect(steps).toEqual(['clear dotNS cache', 'reload']);
  });

  it('As a user, I turn the archive cache back on and keep everything I had', async () => {
    // Given
    const { params, steps } = setupReset();
    const { applyAndReset } = createSettingsActions(params);
    const off: Settings = { ...PRIOR, cache: { ...CACHE_ON, skipArchiveCache: true } };

    // When
    await applyAndReset(PRIOR, off);

    // Then
    expect(steps).toEqual(['reload']);
  });

  it('As a user, I reset everything and the other origins are asked to purge after the wipe that would drop the request', async () => {
    // Given
    const { params, steps, saved } = setupReset();
    const { applyAndReset } = createSettingsActions(params);
    const draft: Settings = { ...PRIOR, backend: 'rpc-gateway' };

    // When
    await applyAndReset(draft, PRIOR, { forceFullWipe: true });

    // Then
    expect(steps).toEqual(['wipe origin', 'schedule protocol and sandbox purge', 'reload']);
    expect(saved.at(-1)?.backend).toBe('rpc-gateway');
  });

  it('As a user whose cache fails to clear, I Save & Apply and the failure is counted while the page still reloads with my new settings', async () => {
    // Given a clear that reported its own failure and resolved false, as the real one does
    const { params, steps, saved, captures, metrics, readPage } = setupReset({
      clearBlockCache: () => Promise.resolve(false),
    });
    const { applyAndReset } = createSettingsActions(params);
    const draft: Settings = { ...PRIOR, cache: { ...CACHE_ON, skipArchiveCache: true } };

    // When
    await applyAndReset(draft, PRIOR);

    // Then: the reload boots with the new settings, from storage and from the URL alike
    expect(steps).toEqual(['reload']);
    expect(saved.at(-1)?.cache.skipArchiveCache).toBe(true);
    expect(new URLSearchParams(readPage().search).get('skipArchiveCache')).toBe('1');
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).not.toHaveBeenCalled();
    expect(metrics.counted('settings.apply')).toEqual([{ outcome: 'error', reason: 'block_cache' }]);
  });

  it('As a user whose dotNS cache fails to clear, I Save & Apply and the failure is counted against that cache', async () => {
    // Given
    const { params, metrics } = setupReset({ clearCidCache: () => Promise.resolve(false) });
    const { applyAndReset } = createSettingsActions(params);

    // When
    await applyAndReset({ ...PRIOR, cache: { ...CACHE_ON, skipCidCache: true } }, PRIOR);

    // Then
    expect(metrics.counted('settings.apply')).toEqual([{ outcome: 'error', reason: 'cid_cache' }]);
  });

  it('As a user whose origin wipe leaves something behind, I Clear all and it is counted while my settings still apply and the page reloads', async () => {
    // Given a wipe that reported its own failed parts
    const { params, steps, saved, captures, metrics } = setupReset({
      wipeOrigin: () => Promise.resolve(['indexeddb']),
    });
    const { applyAndReset } = createSettingsActions(params);

    // When
    await applyAndReset({ ...PRIOR, backend: 'rpc-gateway' }, PRIOR, { forceFullWipe: true });

    // Then
    expect(steps).toEqual(['schedule protocol and sandbox purge', 'reload']);
    expect(saved.at(-1)?.backend).toBe('rpc-gateway');
    expect(captures.exception).not.toHaveBeenCalled();
    expect(metrics.counted('settings.apply')).toEqual([{ outcome: 'error', reason: 'wipe' }]);
  });

  it('As a user without session storage, I Clear all and it still wipes, applies and reloads while the purge request is left as a breadcrumb', async () => {
    // Given
    const refused = new Error('Pending reset not scheduled');
    const { params, steps, saved, captures, metrics } = setupReset({
      schedulePendingReset() {
        throw refused;
      },
    });
    const { applyAndReset } = createSettingsActions(params);

    // When
    await applyAndReset({ ...PRIOR, backend: 'rpc-gateway' }, PRIOR, { forceFullWipe: true });

    // Then
    expect(steps).toEqual(['wipe origin', 'reload']);
    expect(saved.at(-1)?.backend).toBe('rpc-gateway');
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(captures.expected).toHaveBeenCalledWith(refused, expect.objectContaining({ step: 'settings_apply' }));
    expect(metrics.counted('settings.apply')).toEqual([{ outcome: 'error', reason: 'pending_reset' }]);
  });

  it('As a user whose origin wipe and purge request both fail, I Clear all and each failed step is counted once with one warning that the purge request was not stored', async () => {
    // Given a wipe that left something behind, and no session storage for the purge request
    const refused = new Error('Pending reset not scheduled');
    const { params, steps, captures, metrics } = setupReset({
      wipeOrigin: () => Promise.resolve(['indexeddb']),
      schedulePendingReset() {
        throw refused;
      },
    });
    const warnings: string[] = [];
    onTestFinished(
      bindLogSink({
        emit({ level, message }) {
          if (level === 'warn') {
            warnings.push(message);
          }
        },
      }),
    );
    const { applyAndReset } = createSettingsActions(params);

    // When
    await applyAndReset({ ...PRIOR, backend: 'rpc-gateway' }, PRIOR, { forceFullWipe: true });

    // Then both steps are counted in order, only the purge left a breadcrumb and a warning, and the page reloads
    expect(steps).toEqual(['reload']);
    expect(metrics.counted('settings.apply')).toEqual([
      { outcome: 'error', reason: 'wipe' },
      { outcome: 'error', reason: 'pending_reset' },
    ]);
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
  });

  it('As a user whose cache clear throws where it should have resolved, I Save & Apply and the page still reloads while the fault is reported once', async () => {
    // Given a clear that rejects instead of resolving false
    const fault = new TypeError('clear broke');
    const { params, steps, captures, metrics } = setupReset({ clearBlockCache: () => Promise.reject(fault) });
    const { applyAndReset, reset } = createSettingsActions(params);

    // When
    await applyAndReset({ ...PRIOR, cache: { ...CACHE_ON, skipArchiveCache: true } }, PRIOR);

    // Then the page still reloads and the reset keeps reading applying, and the fault is captured and counted beside the steps
    expect(steps).toEqual(['reload']);
    expect(reset.get()).toBe('applying');
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(fault, expect.objectContaining({ step: 'settings_apply' }));
    expect(metrics.counted('settings.apply')).toEqual([{ outcome: 'error', reason: 'fault' }]);
  });

  it('As a user whose page cannot reload, I Save & Apply and the call rejects with the reload error', async () => {
    // Given a reload that throws
    const refused = new Error('reload refused');
    const { params } = setupReset({
      reload() {
        throw refused;
      },
    });
    const { applyAndReset } = createSettingsActions(params);

    // When
    const result = applyAndReset({ ...PRIOR, network: 'previewnet' }, PRIOR);

    // Then
    await expect(result).rejects.toBe(refused);
  });

  it('As an operator, I watch a Save & Apply clear what it had to and it is counted as ok', async () => {
    // Given
    const { params, captures, metrics } = setupReset();
    const { applyAndReset } = createSettingsActions(params);

    // When
    await applyAndReset({ ...PRIOR, cache: { ...CACHE_ON, skipCidCache: true } }, PRIOR);

    // Then
    expect(metrics.counted('settings.apply')).toEqual([{ outcome: 'ok' }]);
    expect(captures.exception).not.toHaveBeenCalled();
  });

  it('As a user, I save my settings and the reload tells the next boot it follows a settings change', async () => {
    // Given
    const { params, reasons } = setupReset();
    const { applyAndReset } = createSettingsActions(params);

    // When
    await applyAndReset({ ...PRIOR, network: 'previewnet' }, PRIOR);

    // Then
    expect(reasons).toEqual(['settings_change']);
  });

  it('As a visitor, I switch backend from a failure screen and my choice is saved and carried in the URL while nothing is wiped and the reload says why', async () => {
    // Given
    const { params, steps, saved, reasons, readPage } = setupReset();
    const { applyAndReset } = createSettingsActions(params);

    // When
    await applyAndReset({ ...PRIOR, backend: 'rpc-gateway' }, PRIOR, { reason: 'switch_backend' });

    // Then
    expect(steps).toEqual(['reload']);
    expect(saved).toEqual([{ ...PRIOR, backend: 'rpc-gateway' }]);
    expect(readPage().search).toBe('?chainBackend=rpc-gateway');
    expect(reasons).toEqual(['switch_backend']);
  });

  it('As a user, I press Save and apply while Clear all caches runs and only the wipe runs, saves and reloads', async () => {
    // Given a full wipe held at its wipe
    const wipe = createDeferred<readonly WipeFailure[]>();
    const { params, steps, saved } = setupReset({
      wipeOrigin() {
        steps.push('wipe origin');
        return wipe.promise;
      },
    });
    const actions = createSettingsActions(params);
    const clearing = actions.applyAndReset(PRIOR, PRIOR, { forceFullWipe: true });
    const draft: Settings = { ...PRIOR, network: 'previewnet' };

    // When
    const second = actions.applyAndReset(draft, PRIOR);
    void second.then(() => {
      steps.push('second settled');
    });
    await Promise.resolve();
    wipe.resolve([]);
    await Promise.all([clearing, second]);

    // Then the second call waited for the wipe, the draft was never saved and the page reloads once
    expect(saved).toEqual([PRIOR]);
    expect(steps).toEqual(['wipe origin', 'schedule protocol and sandbox purge', 'reload', 'second settled']);
  });

  it('As a settings panel, I read the reset and see it clearing from the full wipe on, and never idle again', async () => {
    // Given
    const { params } = setupReset();
    const actions = createSettingsActions(params);
    const before = actions.reset.get();

    // When
    const clearing = actions.applyAndReset(PRIOR, PRIOR, { forceFullWipe: true });
    const during = actions.reset.get();
    await clearing;

    // Then
    expect([before, during, actions.reset.get()]).toEqual(['idle', 'clearing', 'clearing']);
  });

  it('As a settings panel, I read the reset of a save and see it applying', async () => {
    // Given
    const { params } = setupReset();
    const actions = createSettingsActions(params);

    // When
    await actions.applyAndReset({ ...PRIOR, network: 'previewnet' }, PRIOR);

    // Then
    expect(actions.reset.get()).toBe('applying');
  });
});

/** Builds recording fakes for the reset, with the ones a case passes in their place, and binds the failure sinks. */
function setupReset(overrides: Partial<SettingsActionsParams> = {}): ResetStand {
  const steps: string[] = [];
  const saved: Settings[] = [];
  const reasons: Continuation[] = [];
  let page: Page = { pathname: '/', search: '', hash: '' };
  const captures = { exception: vi.fn(), expected: vi.fn() };
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  onTestFinished(bindCaptureSink(captures));
  const params: SettingsActionsParams = {
    clearCidCache() {
      steps.push('clear dotNS cache');
      return Promise.resolve(true);
    },
    clearBlockCache() {
      steps.push('clear archive cache');
      return Promise.resolve(true);
    },
    wipeOrigin() {
      steps.push('wipe origin');
      return Promise.resolve([]);
    },
    schedulePendingReset(targets) {
      steps.push(`schedule ${targets.join(' and ')} purge`);
    },
    reload(reason) {
      steps.push('reload');
      reasons.push(reason);
    },
    save(draft) {
      saved.push(draft);
    },
    url: {
      read: () => page,
      replace(url) {
        const next = new URL(url, 'http://localhost');
        page = { pathname: next.pathname, search: next.search, hash: next.hash };
      },
    },
    ...overrides,
  };
  return { params, steps, saved, reasons, captures, metrics, readPage: () => page };
}
