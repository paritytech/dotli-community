// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the shell and the landing page both run before they part: settings, the protocol iframe, the bridge and the
// auth controller.

// Safari before 18.4 lacks requestIdleCallback.
if (typeof globalThis.requestIdleCallback !== 'function') {
  globalThis.requestIdleCallback = (cb: IdleRequestCallback): number =>
    setTimeout(() => {
      cb({ didTimeout: false, timeRemaining: () => 50 });
    }, 1) as unknown as number;
}

import '@dotli/ui/styles.css';
import { DesktopIcon, RotateCwIcon } from '@dotli/ui/icons';
import { captureException, m, recordExpected, setResolutionId, spans as S } from '@dotli/metrics';
import { reportBlockingModals } from './state/topbar.js';
import { listenForChunkFailures } from '@dotli/ui-widgets';
import { showError } from './error-page.js';
import { prefetchOverlays, showNotification } from './overlays.js';
import { reportChunkFailure } from './ui-reporter.js';
import { configureProtocolFrame, ensureProtocolFrame, warmupProtocol, type ProtocolFrameConfig } from '@dotli/protocol';
import { isMobileDevice } from './device.js';
import { log } from '@dotli/shared';
import { markContinuation } from './continuation.js';
import { getBackend, getCacheSettings, getNetwork, persistDefaults, type Backend } from '@dotli/config';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import {
  loadBridge,
  loadSharedMode,
  type BridgeModule,
  createBlockingModalCoordinator,
  setProductError,
  takePendingReset,
  initAuthController,
  startSessionState,
} from '@dotli/host-runtime';
import { describeError, RELOAD_BTN_LABEL } from './errors.js';
import { applyUrlSettings, readPersistedSettings } from './url-settings.js';
import { loadBridgePorts } from './lazy.js';
import { resetAuthModal, updateAuthModal } from './state/auth-modal.js';
import { initSettingsStore } from './state/settings.js';
import { pageSettingsActions } from './settings-actions.js';

export const T0 = performance.now();

listenForChunkFailures({
  target: window,
  notify: showNotification,
  reload: () => {
    markContinuation('app_update');
    window.location.reload();
  },
  report: reportChunkFailure,
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
      icon: DesktopIcon,
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

/** The frame follows the settings in force now. A pending reset forces a clean chain DB whatever the cache says. */
function protocolFrameConfig(pendingReset: boolean): ProtocolFrameConfig {
  const backend = getBackend();
  return {
    mode: backend === 'smoldot-shared-worker' ? 'shared-worker' : backend === 'smoldot-direct' ? 'direct' : 'rpc',
    network: getNetwork(),
    skipWorkerCache: pendingReset || getCacheSettings().skipWorkerCache,
  };
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

/** What only the shell has. The landing page renders neither, so it passes neither. */
export interface StartHostOptions {
  /** Feeds the shell's debug panel. */
  emitDotliDebugEvent?: EmitFn;
  /** Starts the state the shell's chrome renders. */
  startShellState?: () => void;
}

/** Boots the host's settings, shared mode and bridge, and starts the shell state when the page has one. */
export async function startHost(bootFlowId: string, options: StartHostOptions = {}): Promise<HostStartup> {
  const { emitDotliDebugEvent = () => undefined, startShellState } = options;
  // One id for the debug panel's flow and the Sentry trace, so the two line up.
  setResolutionId(bootFlowId);
  const persisted = readPersistedSettings();
  persistDefaults();
  // Before the first await, so the capsule shows going offline at once and no island mounts on a store not yet started.
  startShellState?.();

  // Taken before the shared store's first read boots the frame, so that boot already purges.
  const protocolPendingReset = takePendingReset('protocol');

  // Before any consumer reads the settings. A URL-driven wipe reloads here, so nothing below runs.
  boot.step = 'url_settings';
  await applyUrlSettings(persisted, {
    search: window.location.search,
    configureFrame: () => {
      configureProtocolFrame(protocolFrameConfig(protocolPendingReset));
    },
    bootstrapSharedMode: async () => {
      const { bootstrapSharedMode } = await loadSharedMode();
      await bootstrapSharedMode();
    },
    actions: pageSettingsActions,
    notify: showNotification,
    replaceSearch: query => {
      const { pathname, hash } = window.location;
      window.history.replaceState(null, '', `${pathname}${query ? `?${query}` : ''}${hash}`);
    },
  });
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
    const frameConfig = protocolFrameConfig(protocolPendingReset);
    configureProtocolFrame(frameConfig);
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
      payload: { subMode: frameConfig.mode },
    });
  }

  const blockingModalCoordinator = createBlockingModalCoordinator({ report: reportBlockingModals });
  // The ports load beside the bridge, so the bridge's dialogs never join the boot chunk.
  const bridgeReady = Promise.all([loadBridge(), loadBridgePorts()]).then(([bridge, ports]) => {
    bridge.initBridge({
      coordinator: blockingModalCoordinator,
      prompts: ports.hostPrompts,
      notifications: ports.scheduledNotifications,
      frameView: ports.productFrameView,
      chainActivity: ports.chainActivity,
    });
    return bridge;
  });
  initAuthController({
    coordinator: blockingModalCoordinator,
    modal: { update: updateAuthModal, reset: resetAuthModal },
    commands: async () => (await bridgeReady).authCommands,
  });

  boot.step = 'bridge_load';
  const bridgeModule = await bridgeReady;

  boot.step = 'topbar';
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
  void showError(error.title, error.message, {
    label: RELOAD_BTN_LABEL,
    icon: RotateCwIcon,
    onClick: () => {
      markContinuation('reload_button');
      window.location.reload();
    },
  });
  setProductError();
}
