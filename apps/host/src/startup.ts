// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the shell and the landing page both run before they part: settings, the protocol iframe, the bridge's login
// listeners and the auth controller.

// Safari before 18.4 lacks requestIdleCallback.
if (typeof globalThis.requestIdleCallback !== 'function') {
  globalThis.requestIdleCallback = (cb: IdleRequestCallback): number =>
    setTimeout(() => {
      cb({ didTimeout: false, timeRemaining: () => 50 });
    }, 1) as unknown as number;
}

import '@dotli/ui/styles.css';
import { captureException, m, recordExpected, setResolutionId, spans as S } from '@dotli/metrics';
import {
  RELOAD_GLYPH,
  createBlockingModalCoordinator,
  initSettingsStore,
  initTopBar,
  loadBridge,
  loadSharedMode,
  prefetchOverlays,
  showError,
  showNotification,
  startSessionState,
  wipeOriginState,
  type BridgeModule,
} from '@dotli/ui';
import { ensureProtocolFrame, resetProtocolFrame, setProtocolSubMode, warmupProtocol } from '@dotli/protocol';
import { dur, isMobileDevice, log, markContinuation } from '@dotli/shared';
import {
  BACKEND_KEY,
  CACHE_KEY,
  NETWORK_KEY,
  getBackend,
  getCacheSettings,
  getNetwork,
  isSharedWorkerAvailable,
  parseSettingsFromSearch,
  setBackend,
  setCacheSettings,
  setNetwork,
  writeSettingsToSearch,
  type Backend,
} from '@dotli/config';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { describeError, RELOAD_BTN_LABEL } from './errors.js';

const bootLog = log.child({ flow: 'boot' });

export const T0 = performance.now();

// The user opts into a reload rather than getting a silent one.
window.addEventListener('vite:preloadError', event => {
  const evt = event as unknown as { payload?: unknown };
  captureException(evt.payload ?? new Error('vite:preloadError'), {
    flow: 'boot',
    step: 'chunk_preload',
    tags: { kind: 'chunk_preload_error' },
  });
  showNotification({
    label: 'Asset failed to load',
    text: 'A new version may have been deployed. Reload to get the latest.',
    tone: 'err',
    dismissMs: 0,
    action: {
      label: 'Reload',
      onClick: () => {
        markContinuation('app_update');
        window.location.reload();
      },
    },
  });
});

// In memory before a deploy could make later chunk loads fail.
prefetchOverlays();

if (!isMobileDevice()) {
  const dismissed = localStorage.getItem('desktop-banner-dismissed');
  if (dismissed === null) {
    showNotification({
      label: 'Get Polkadot Desktop',
      text: 'Full experience with native performance',
      deeplink: import.meta.env.VITE_DESKTOP_DOWNLOAD_URL ?? 'https://polkadot.com/get-started/polkadot-for-desktop',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><path d="M8 21h8m-4-4v4"/></svg>',
      dismissMs: 0,
      browserNotification: false,
      onDismiss: () => {
        localStorage.setItem('desktop-banner-dismissed', '1');
      },
    });
  }
}

if (m.enabled && typeof PerformanceObserver !== 'undefined') {
  const wasmObserver = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      if (entry.name.endsWith('.wasm')) {
        const name = entry.name.split('/').pop() ?? 'unknown';
        m.distribution(S.WASM_LOAD, entry.duration, 'millisecond', {
          module: name,
        });
      }
    }
  });
  wasmObserver.observe({ type: 'resource', buffered: true });
}

/** Boot runs before the resolution trace exists, so this says where a boot failure happened. */
export const boot = { step: 'start' };

export type EmitFn = (e: DotliDebugEvent) => void;

/** Null when Safari private mode throws. */
function readRawLocalStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Per setting, URL beats the shared store, which beats localStorage and the default. A URL value that displaces a
 * persisted choice wipes and reloads, as Save does.
 */
async function applyUrlSettings(): Promise<void> {
  const search = new URLSearchParams(window.location.search);
  const parsed = parseSettingsFromSearch(search);

  // Before the getters below, which seed defaults on first read and would make every fresh visit look like a change.
  const hadPriorPersisted =
    readRawLocalStorage(NETWORK_KEY) !== null ||
    readRawLocalStorage(BACKEND_KEY) !== null ||
    readRawLocalStorage(CACHE_KEY) !== null;

  const rawUrlBackend = search.get('chainBackend');
  const rawPersistedBackend = readRawLocalStorage(BACKEND_KEY);
  const sharedWorkerFallback =
    !isSharedWorkerAvailable() &&
    (rawUrlBackend === 'smoldot-shared-worker' || rawPersistedBackend === 'smoldot-shared-worker');

  // Before reading prior values, so they reflect the cross-subdomain store and the writes below mirror to it.
  try {
    const { bootstrapSharedMode } = await loadSharedMode();
    await bootstrapSharedMode();
  } catch (err: unknown) {
    bootLog.warn('[dot.li] Shared mode bootstrap failed; continuing with per-origin localStorage:', err);
  }

  const prior = {
    network: getNetwork(),
    chain: getBackend(),
    cache: getCacheSettings(),
  };

  const next = {
    network: parsed.network ?? prior.network,
    chain: parsed.chainBackend ?? prior.chain,
    cache: {
      skipArchiveCache: parsed.skipArchiveCache ?? prior.cache.skipArchiveCache,
      skipCidCache: parsed.skipCidCache ?? prior.cache.skipCidCache,
      skipWorkerCache: parsed.skipWorkerCache ?? prior.cache.skipWorkerCache,
    },
  };

  setNetwork(next.network);
  setBackend(next.chain);
  setCacheSettings(next.cache);

  if (writeSettingsToSearch({ network: next.network, chainBackend: next.chain, cache: next.cache }, search)) {
    const query = search.toString();
    const newUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    window.history.replaceState(null, '', newUrl);
  }

  if (sharedWorkerFallback) {
    showNotification({
      label: 'Light client shared unavailable',
      text: "This browser doesn't support Light client shared. Falling back to Light client per tab.",
      tone: 'warn',
      dismissMs: 5_000,
    });
  }

  const changed =
    next.network !== prior.network ||
    next.chain !== prior.chain ||
    next.cache.skipArchiveCache !== prior.cache.skipArchiveCache ||
    next.cache.skipCidCache !== prior.cache.skipCidCache ||
    next.cache.skipWorkerCache !== prior.cache.skipWorkerCache;

  // The bootstrap loaded the protocol iframe with the prior backend, so it is rebuilt in the new sub-mode.
  if (prior.chain !== next.chain) {
    resetProtocolFrame();
  }

  // A fresh origin has nothing stale, and a URL that matches localStorage changes nothing.
  if (!changed || !hadPriorPersisted) {
    return;
  }

  // The other two origins purge themselves on their next boot. The wipe keeps the theme and analytics id itself.
  await wipeOriginState();
  setNetwork(next.network);
  setBackend(next.chain);
  setCacheSettings(next.cache);
  try {
    sessionStorage.setItem('dotli:pending-reset:protocol', '1');
    sessionStorage.setItem('dotli:pending-reset:sandbox', '1');
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in Safari private mode, so cross-origin purges are best-effort while the reload below is unconditional.
  } catch {
    /* sessionStorage unavailable */
  }
  // After the wipe, which clears sessionStorage and would take the mark with it.
  markContinuation('settings_change');
  window.location.reload();
}

export interface HostStartup {
  chainBackend: Backend;
  cacheSettings: ReturnType<typeof getCacheSettings>;
  bridgeModule: BridgeModule;
}

export function createBootFlowId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `boot-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
}

/** `emitDotliDebugEvent` feeds the shell's debug panel. The landing page has none. */
export async function startHost(
  bootFlowId: string,
  emitDotliDebugEvent: EmitFn = () => undefined,
): Promise<HostStartup> {
  // One id for the debug panel's flow and the Sentry trace, so the two line up.
  setResolutionId(bootFlowId);

  // Before any consumer reads the settings. A URL-driven wipe reloads here, so nothing below runs.
  boot.step = 'url_settings';
  await applyUrlSettings();
  initSettingsStore();

  const chainBackend = getBackend();
  const cacheSettings = getCacheSettings();
  emitDotliDebugEvent({
    layer: 'boot',
    event: 'started',
    flowId: bootFlowId,
    timestamp: Date.now(),
    payload: {
      chainBackend,
      skipCidCache: cacheSettings.skipCidCache,
      skipArchiveCache: cacheSettings.skipArchiveCache,
    },
  });
  log.event('Settings applied', {
    flow: 'boot',
    network: getNetwork(),
    backend: chainBackend,
    skip_cid_cache: cacheSettings.skipCidCache,
    skip_archive_cache: cacheSettings.skipArchiveCache,
    skip_worker_cache: cacheSettings.skipWorkerCache,
  });
  m.setDefaults({
    network: getNetwork(),
    chain_backend: chainBackend,
    skip_cid_cache: String(cacheSettings.skipCidCache),
    skip_archive_cache: String(cacheSettings.skipArchiveCache),
    skip_worker_cache: String(cacheSettings.skipWorkerCache),
  });

  // On every backend, so a sandboxed app's `chainConnect` finds a handler waiting.
  {
    const subMode: 'shared-worker' | 'direct' | 'rpc' =
      chainBackend === 'smoldot-shared-worker' ? 'shared-worker' : chainBackend === 'smoldot-direct' ? 'direct' : 'rpc';
    // One-shot, from Save & Apply: forces a clean chain DB on the protocol origin whatever the cache settings say.
    let pendingProtocolReset = false;
    try {
      if (sessionStorage.getItem('dotli:pending-reset:protocol') === '1') {
        pendingProtocolReset = true;
        sessionStorage.removeItem('dotli:pending-reset:protocol');
      }
      // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in Safari private mode, so the reset flag falls back to false which is the safe default.
    } catch {
      /* sessionStorage unavailable: skip pending-reset pick up */
    }
    setProtocolSubMode(subMode, {
      skipWorkerCache: pendingProtocolReset || cacheSettings.skipWorkerCache,
    });
    // The first request that needs the frame awaits these again and reports a failure there, so here it is a crumb.
    ensureProtocolFrame().catch((err: unknown) => {
      recordExpected(err, { flow: 'protocol', step: 'frame_prewarm' });
    });
    warmupProtocol().catch((err: unknown) => {
      recordExpected(err, { flow: 'protocol', step: 'warmup' });
    });
    emitDotliDebugEvent({
      layer: 'boot',
      event: 'protocol_warmup_started',
      flowId: bootFlowId,
      timestamp: Date.now(),
      payload: { subMode },
    });
  }

  const blockingModalCoordinator = createBlockingModalCoordinator();

  boot.step = 'bridge_load';
  const bridgeModule = await loadBridge();
  bridgeModule.initBridgeEventListeners(blockingModalCoordinator);

  boot.step = 'topbar';
  const t0 = performance.now();
  initTopBar(blockingModalCoordinator);
  log.debug(`[dot.li perf] initTopBar() done (${dur(t0)})`);
  // At once, not on idle: the auth button spins until the saved session is read, and a busy boot can starve an idle
  // callback.
  startSessionState();
  emitDotliDebugEvent({
    layer: 'boot',
    event: 'topbar_ready',
    flowId: bootFlowId,
    timestamp: Date.now(),
    payload: {},
  });

  return {
    chainBackend,
    cacheSettings,
    bridgeModule,
  };
}

/** For a failure before either page had anything to show. */
export function reportBootFailure(err: unknown): void {
  captureException(err, { flow: 'boot', step: boot.step });
  const error = describeError(err, getBackend() !== 'rpc-gateway');
  showError(error.title, error.message, {
    label: RELOAD_BTN_LABEL,
    icon: RELOAD_GLYPH,
    onClick: () => {
      markContinuation('reload_button');
      window.location.reload();
    },
  });
}
