// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the shell and the landing page both run before they part: the page's own start, then settings, the protocol
// iframe, the bridge and the auth controller.

import '@dotli/ui/styles.css';
import { RotateCwIcon } from '@dotli/ui/icons';
import { captureException, m, recordExpected, setResolutionId, spans as S } from '@dotli/metrics';
import { reportBlockingModals } from './state/topbar.js';
import { listenForChunkFailures, refuseModals, showError, showNotification } from '@dotli/ui';
import { protocolClient, type ProtocolFrameConfig } from '@dotli/protocol';
import { isMobileDevice } from './device.js';
import { offerDesktopApp } from './desktop-offer.js';
import { pageStandIns, reportIslandErrors } from './island-errors.js';
import { log, pageLocalStorage } from '@dotli/shared';
import { markContinuation } from './continuation.js';
import { getBackend, isLocalhost, isSharedWorkerAvailable, type Settings } from '@dotli/config';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { loadBridge, type BridgeModule } from './lazy.js';
import { createBlockingModalCoordinator } from './runtime/blocking-modal-queue.js';
import { setProductError } from './runtime/state/product.js';
import { takePendingReset } from './runtime/pending-reset.js';
import { readSharedSettings, writeSharedSettings } from './runtime/shared-mode.js';
import { disableAuthModal, initAuthController } from './runtime/auth-controller.js';
import { describeError, RELOAD_BTN_LABEL } from './errors.js';
import { bootSettings } from './boot-settings.js';
import { initSettingsStore } from './state/settings.js';
import { pageSettingsActions } from './settings-actions.js';

export const T0 = performance.now();

/** What a page load starts first: the chunk and island failure offers, the desktop offer and the wasm timings. */
export function startPage(): void {
  const reload = (): void => {
    markContinuation('app_update');
    window.location.reload();
  };
  listenForChunkFailures({ target: window, notify: showNotification, reload });
  reportIslandErrors({
    notify: showNotification,
    reload,
    standIns: pageStandIns({
      disableAuthModal,
      refuseModals: () => {
        refuseModals();
      },
    }),
  });

  if (!isMobileDevice()) {
    offerDesktopApp({
      storage: pageLocalStorage,
      notify: showNotification,
      downloadUrl: import.meta.env.VITE_DESKTOP_DOWNLOAD_URL,
    });
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
}

/** Boot runs before the resolution trace exists, so this says where a boot failure happened. */
export const boot = { step: 'start' };

export type EmitFn = (e: DotliDebugEvent) => void;

/** A pending reset forces a clean chain DB whatever the cache says. */
function protocolFrameConfig(settings: Settings, pendingReset: boolean): ProtocolFrameConfig {
  return {
    backend: settings.backend,
    network: settings.network,
    skipWorkerCache: pendingReset || settings.cache.skipWorkerCache,
  };
}

export interface HostStartup {
  settings: Settings;
  bridgeModule: BridgeModule;
}

/** What only the shell has. The landing page renders no chrome and shows no debug panel, so it passes neither. */
export interface StartHostOptions {
  /** The shell's debug bus. An option, so the landing page's first load does not carry the bus. */
  emitDotliDebugEvent?: EmitFn;
  /** Starts the state the shell's chrome renders, right after this origin's settings and the link's are set. */
  startShellState?: () => void;
}

/** Boots the host's settings, shared mode and bridge, and starts the shell state when the page has one. */
export async function startHost(bootFlowId: string, options: StartHostOptions = {}): Promise<HostStartup> {
  const { emitDotliDebugEvent = () => undefined, startShellState } = options;
  // One id for the debug panel's flow and the Sentry trace, so the two line up.
  setResolutionId(bootFlowId);
  // Taken before the shared store's first read boots the frame, so that boot already purges.
  const protocolPendingReset = takePendingReset('protocol');

  // Before the first await this sets this origin's settings and the link's and boots the frame on them. A URL-driven
  // wipe reloads, so nothing below runs.
  boot.step = 'url_settings';
  const settingsBoot = bootSettings({
    search: window.location.search,
    local: pageLocalStorage,
    sharedWorkerAvailable: isSharedWorkerAvailable(),
    preferLocal: isLocalhost,
    readShared: () => readSharedSettings(),
    writeShared: shared => {
      void writeSharedSettings(shared);
    },
    configureFrame: settings => {
      protocolClient().configureProtocolFrame(protocolFrameConfig(settings, protocolPendingReset));
    },
    actions: pageSettingsActions,
    notify: showNotification,
    replaceSearch: query => {
      const { pathname, hash } = window.location;
      window.history.replaceState(null, '', `${pathname}${query ? `?${query}` : ''}${hash}`);
    },
  });
  // After this origin's settings are set and before the first await, so the capsule shows going offline at once and no
  // island mounts on a store not yet started.
  startShellState?.();
  const settings = await settingsBoot;
  initSettingsStore();

  emitDotliDebugEvent({
    layer: 'boot',
    event: 'started',
    flowId: bootFlowId,
    timestamp: Date.now(),
    payload: {
      chainBackend: settings.backend,
      skipCidCache: settings.cache.skipCidCache,
      skipArchiveCache: settings.cache.skipArchiveCache,
    },
  });
  log.event('Settings applied', {
    flow: 'boot',
    network: settings.network,
    backend: settings.backend,
    skip_cid_cache: settings.cache.skipCidCache,
    skip_archive_cache: settings.cache.skipArchiveCache,
    skip_worker_cache: settings.cache.skipWorkerCache,
  });
  m.setDefaults({
    network: settings.network,
    chain_backend: settings.backend,
    skip_cid_cache: String(settings.cache.skipCidCache),
    skip_archive_cache: String(settings.cache.skipArchiveCache),
    skip_worker_cache: String(settings.cache.skipWorkerCache),
  });

  // On every backend, so a sandboxed app's `chainConnect` finds a handler waiting. The boot configured the frame.
  // The first request that needs the frame awaits these again and reports a failure there, so here it is a crumb.
  protocolClient()
    .ensureProtocolFrame()
    .catch((err: unknown) => {
      recordExpected(err, { flow: 'protocol', step: 'frame_prewarm' });
    });
  protocolClient()
    .warmupProtocol()
    .catch((err: unknown) => {
      recordExpected(err, { flow: 'protocol', step: 'warmup' });
    });
  emitDotliDebugEvent({
    layer: 'boot',
    event: 'protocol_warmup_started',
    flowId: bootFlowId,
    timestamp: Date.now(),
    payload: { subMode: settings.backend },
  });

  const blockingModalCoordinator = createBlockingModalCoordinator({ report: reportBlockingModals });
  // The bridge chunk brings the dialogs it asks with, so they never join the boot chunk.
  const bridgeReady = loadBridge().then(bridge => {
    bridge.initBridge(blockingModalCoordinator);
    return bridge;
  });
  initAuthController({
    coordinator: blockingModalCoordinator,
    commands: async () => (await bridgeReady).authCommands,
  });

  boot.step = 'bridge_load';
  const bridgeModule = await bridgeReady;

  boot.step = 'topbar';
  // At once, not on idle: the auth button spins until the saved session is read, and a busy boot can starve an idle
  // callback.
  bridgeModule.startSessionState();
  emitDotliDebugEvent({
    layer: 'boot',
    event: 'topbar_ready',
    flowId: bootFlowId,
    timestamp: Date.now(),
    payload: {},
  });

  return { settings, bridgeModule };
}

/** For a failure before either page had anything to show. */
export function reportBootFailure(err: unknown): void {
  captureException(err, { flow: 'boot', step: boot.step });
  const error = describeError(err, getBackend() !== 'rpc-gateway');
  showError(error.title, error.message, {
    label: RELOAD_BTN_LABEL,
    icon: RotateCwIcon,
    onClick: () => {
      markContinuation('reload_button');
      window.location.reload();
    },
  });
  setProductError();
}
