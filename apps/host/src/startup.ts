// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What every page runs before they part: the page's own start, then settings, the protocol iframe, the bridge and,
// on a page with a sign-in modal, the auth controller.

import '@dotli/ui/styles.css';
import { RotateCwIcon } from '@dotli/ui/icons';
import { captureException, m, recordExpected, setResolutionId, spans as S } from '@dotli/metrics';
import { reportBlockingModals } from './state/topbar.js';
import { createReloadOffer, listenForChunkFailures, refuseModals, showError, showNotification } from '@dotli/ui';
import { protocolClient, type ProtocolFrameConfig } from '@dotli/protocol';
import { isMobileDevice } from './device.js';
import { offerDesktopApp } from './desktop-offer.js';
import { pageStandIns, reportIslandErrors } from './island-errors.js';
import { log, pageLocalStorage } from '@dotli/shared';
import { markContinuation } from './continuation.js';
import { getBackend, isLocalhost, isSharedWorkerAvailable, setSettings, type Settings } from '@dotli/config';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { loadBridge, loadRecoveryPhrase, type BridgeModule } from './lazy.js';
import { createBlockingModalCoordinator } from './runtime/blocking-modal-queue.js';
import { setProductError } from './runtime/state/product.js';
import { takePendingReset } from './runtime/pending-reset.js';
import { readSharedSettings, writeSharedSettings } from './runtime/shared-mode.js';
import { disableAuthModal, initAuthController } from './runtime/auth-controller.js';
import { pageSignInHandoff } from './runtime/session-handoff/opener.js';
import { choosePageRole, showsSession, signInSurface, type PageRole } from './runtime/page-role.js';
import { describeError, RELOAD_BTN_LABEL } from './errors.js';
import { bootSettings } from './boot-settings.js';
import { initSettingsStore } from './state/settings.js';
import { pageSettingsActions } from './settings-actions.js';

export const T0 = performance.now();

/**
 * What a page load starts first: the chunk and island failure offers, the desktop offer and the wasm timings.
 * `desktopOffer: false` leaves out the desktop offer.
 */
export function startPage(options: { desktopOffer?: boolean } = {}): void {
  const { desktopOffer = true } = options;
  // One offer for the page, so chunk and island failures never stack reload toasts.
  const offerReload = createReloadOffer(showNotification, () => {
    markContinuation('app_update');
    window.location.reload();
  });
  listenForChunkFailures({ target: window, offerReload });
  reportIslandErrors({
    offerReload,
    standIns: pageStandIns({
      disableAuthModal,
      refuseModals: () => {
        refuseModals();
      },
    }),
  });

  if (desktopOffer && !isMobileDevice()) {
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

export type HostStartup = {
  settings: Settings;
  bridgeModule: BridgeModule;
};

/** What the page is, and what only the shell has. The landing page renders no chrome and shows no debug panel. */
export type StartHostOptions = {
  /** What the page is to sign-in, chosen by its entry. */
  role: PageRole;
  /** The shell's debug bus. An option, so the landing page's first load does not carry the bus. */
  emitDotliDebugEvent?: EmitFn;
  /** Starts the state the shell's chrome renders, right after this origin's settings and the link's are set. */
  startShellState?: () => void;
  /**
   * Settings the page fixed before boot, for the sign-in window. Nothing reads the link's settings or stores any, so a
   * network that differs from the saved one never wipes or reloads the page.
   */
  settings?: Settings;
};

/** Boots the host's settings, shared mode and bridge, and starts the shell state when the page has one. */
export async function startHost(bootFlowId: string, options: StartHostOptions): Promise<HostStartup> {
  const { role, emitDotliDebugEvent = () => undefined, startShellState } = options;
  // First, as the presence, the wallet boot and core storage read it on first use.
  choosePageRole(role);
  // One id for the debug panel's flow and the Sentry trace, so the two line up.
  setResolutionId(bootFlowId);
  // Taken before the shared store's first read boots the frame, so that boot already purges.
  const protocolPendingReset = takePendingReset('protocol');

  const configureFrame = (settings: Settings): void => {
    protocolClient().configureProtocolFrame(protocolFrameConfig(settings, protocolPendingReset));
  };
  // Before the first await this sets this origin's settings and the link's and boots the frame on them. A URL-driven
  // wipe reloads, so nothing below runs.
  boot.step = 'url_settings';
  const settingsBoot =
    options.settings === undefined
      ? bootSettings({
          search: window.location.search,
          local: pageLocalStorage,
          sharedWorkerAvailable: isSharedWorkerAvailable(),
          preferLocal: isLocalhost,
          readShared: () => readSharedSettings(),
          writeShared: shared => {
            void writeSharedSettings(shared);
          },
          configureFrame,
          actions: pageSettingsActions,
          notify: showNotification,
          replaceSearch: query => {
            const { pathname, hash } = window.location;
            window.history.replaceState(null, '', `${pathname}${query ? `?${query}` : ''}${hash}`);
          },
        })
      : Promise.resolve(fixSettings(options.settings, configureFrame));
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
  if (signInSurface(role) !== 'self') {
    initAuthController({
      coordinator: blockingModalCoordinator,
      commands: async () => (await bridgeReady).authCommands,
      handoff: pageSignInHandoff(role),
      applyResult: async result => (await bridgeReady).applyWindowResult(result),
      inPagePhrase: async () => {
        const [{ phraseToEntropy }, { walletSwitch }] = await Promise.all([loadRecoveryPhrase(), bridgeReady]);
        return { toEntropy: phraseToEntropy, useLocalWallet: entropy => walletSwitch.useLocalWallet(entropy) };
      },
    });
  }

  boot.step = 'bridge_load';
  const bridgeModule = await bridgeReady;

  boot.step = 'topbar';
  // At once, not on idle: the auth button spins until the saved session is read, and a busy boot can starve an idle
  // callback.
  if (showsSession(role)) {
    bridgeModule.startSessionState();
  }
  emitDotliDebugEvent({
    layer: 'boot',
    event: 'topbar_ready',
    flowId: bootFlowId,
    timestamp: Date.now(),
    payload: {},
  });

  return { settings, bridgeModule };
}

/** Sets settings fixed before boot and boots the frame on them, with no store to read or write. */
function fixSettings(settings: Settings, configureFrame: (settings: Settings) => void): Settings {
  setSettings(settings);
  configureFrame(settings);
  return settings;
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
