// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What every page runs once its own start is done: settings, the protocol iframe, the bridge and, on a page with a
// sign-in modal, the auth controller.

import { createReporter, defineCount, m, setResolutionId } from '@dotli/metrics';
import { topbarState } from './state/topbarState.js';
import { showNotification } from '@dotli/ui';
import { getProtocolClient, type ProtocolFrameConfig } from '@dotli/protocol';
import { markHandled, pageLocalStorage } from '@dotli/shared';
import { bootTracker } from './createBootTracker.js';
import { isLocalhost, isSharedWorkerAvailable, setSettings, type Settings } from '@dotli/config';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { loadHostBridge, loadRecoveryPhrase } from './lazy.js';
import { createBlockingModalCoordinator } from './runtime/createBlockingModalCoordinator.js';
import { networkPause } from './runtime/createNetworkPause.js';
import { pendingResets } from './runtime/createPendingResets.js';
import { readSharedSettings, writeSharedSettings } from './runtime/sharedMode.js';
import { authControl } from './runtime/createAuthController.js';
import { getPageSignInHandoff } from './runtime/sessionHandoff/createSessionHandoff.js';
import { pageRole, isSessionShown, getSignInSurface, type PageRole } from './runtime/pageRole.js';
import { readBootSettings } from './readBootSettings.js';
import { settingsState } from './state/settingsState.js';
import { pageSettingsActions } from './createSettingsActions.js';

const bootReport = createReporter({ flow: 'boot' });
const protocolReport = createReporter({ flow: 'protocol' });

/**
 * Count. The boot's early start of the protocol frame failed. Expected. Tagged `outcome` (error) and `reason` (the
 * error's name).
 */
const protocolFramePrewarmMetric = defineCount<'error'>('protocol.frame_prewarm');

/** Count. The boot's resolver warm-up failed. Expected. Tagged `outcome` (error) and `reason` (the error's name). */
const resolveWarmupMetric = defineCount<'error'>('resolve.warmup');

export type EmitDebugEvent = (event: DotliDebugEvent) => void;

export type HostStartup = Awaited<ReturnType<typeof startHost>>;

/** What the page is, and what only the shell has. The landing page renders no chrome and shows no debug panel. */
export type StartHostParams = {
  /** One id for the debug panel's flow and the Sentry trace. */
  bootFlowId: string;
  /** What the page is to sign-in, chosen by its entry. */
  role: PageRole;
  /** The shell's debug bus. An option, so the landing page's first load does not carry the bus. */
  emitDotliDebugEvent?: EmitDebugEvent;
  /** Starts the state the shell's chrome renders, right after this origin's settings and the link's are set. */
  startShellState?: () => void;
  /**
   * Settings the page fixed before boot, for the sign-in window. Nothing reads the link's settings or stores any, so a
   * network that differs from the saved one never wipes or reloads the page.
   */
  settings?: Settings;
};

/**
 * Boots the host's settings, shared mode and bridge, and starts the shell state when the page has one. Rejects with
 * what the settings boot or the bridge load threw, and a settings failure wins when both fail. It sets this origin's
 * settings and the link's before its first await, so a caller that does not await it may read them at once. The
 * shared settings read after that never change the network.
 */
export async function startHost({
  bootFlowId,
  role,
  emitDotliDebugEvent = () => undefined,
  startShellState,
  settings: fixedSettings,
}: StartHostParams) {
  // First, as the presence, the wallet boot and core storage read it on first use.
  pageRole.choose(role);
  // One id for the debug panel's flow and the Sentry trace, so the two line up.
  setResolutionId(bootFlowId);
  // Taken before the shared store's first read boots the frame, so that boot already purges.
  const protocolPendingReset = pendingResets.take('protocol');

  function configureFrame(settings: Settings): void {
    getProtocolClient().frame.configure(getProtocolFrameConfig(settings, protocolPendingReset));
  }
  // Before the first await this sets this origin's settings and the link's and boots the frame on them. A URL-driven
  // wipe reloads, so nothing below runs.
  bootTracker.setStep('url_settings');
  const settingsBoot =
    fixedSettings === undefined
      ? readBootSettings({
          search: window.location.search,
          local: pageLocalStorage,
          sharedWorkerAvailable: isSharedWorkerAvailable(),
          preferLocal: isLocalhost,
          readShared: () => readSharedSettings(),
          writeShared(shared) {
            void writeSharedSettings(shared);
          },
          configureFrame,
          actions: pageSettingsActions,
          notify: showNotification,
          replaceSearch(query) {
            const { pathname, hash } = window.location;
            window.history.replaceState(null, '', `${pathname}${query ? `?${query}` : ''}${hash}`);
          },
        })
      : Promise.resolve(fixSettings(fixedSettings, configureFrame));
  // After this origin's settings are set and before the first await, so the capsule shows going offline at once and no
  // island mounts on a store not yet started.
  startShellState?.();
  // The pause and its targets last the page's life, so their stops go unused.
  networkPause.start();
  networkPause.addTarget(getProtocolClient().chains);
  // The chunk loads before the settings settle, so it must not depend on them. Its failure is awaited at the bridge load, or
  // dropped when the settings fail first.
  const bridgeChunk = markHandled(loadHostBridge());
  const settings = await settingsBoot;
  settingsState.init();

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
  bootReport.log.event('Settings applied', {
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
  // The first request that needs the frame awaits these again and reports a failure there, so here it is expected.
  getProtocolClient()
    .frame.ensureReady()
    .catch((error: unknown) => {
      protocolReport.expected(error, { step: 'frame_prewarm', metric: protocolFramePrewarmMetric });
    });
  getProtocolClient()
    .resolve.warmup()
    .catch((error: unknown) => {
      protocolReport.expected(error, { step: 'warmup', metric: resolveWarmupMetric });
    });
  emitDotliDebugEvent({
    layer: 'boot',
    event: 'protocol_warmup_started',
    flowId: bootFlowId,
    timestamp: Date.now(),
    payload: { subMode: settings.backend },
  });

  const blockingModalCoordinator = createBlockingModalCoordinator({ report: topbarState.reportBlockingModals });
  // The bridge chunk brings the dialogs it asks with, so they never join the boot chunk.
  const bridgeReady = bridgeChunk.then(loaded => {
    loaded.initBridge(blockingModalCoordinator);
    return loaded;
  });
  if (getSignInSurface(role) !== 'self') {
    authControl.init({
      coordinator: blockingModalCoordinator,
      bridge: () => bridgeReady,
      handoff: getPageSignInHandoff(role),
      loadRecoveryPhrase,
    });
  }

  bootTracker.setStep('bridge_load');
  const bridge = await bridgeReady;
  networkPause.addTarget(bridge.hostChainPool);

  bootTracker.setStep('topbar');
  // At once, not on idle: the auth button spins until the saved session is read, and a busy boot can starve an idle
  // callback. The state lasts the page's life, so its stop goes unused.
  if (isSessionShown(role)) {
    bridge.startSessionState();
  }
  emitDotliDebugEvent({
    layer: 'boot',
    event: 'topbar_ready',
    flowId: bootFlowId,
    timestamp: Date.now(),
    payload: {},
  });

  return {
    /** The settings the page runs on. */
    settings,
    /** The loaded bridge, initialised. */
    bridge,
  };
}

/** A pending reset forces a clean chain DB whatever the cache says. */
function getProtocolFrameConfig(settings: Settings, pendingReset: boolean): ProtocolFrameConfig {
  return {
    backend: settings.backend,
    network: settings.network,
    skipWorkerCache: pendingReset || settings.cache.skipWorkerCache,
  };
}

/** Sets settings fixed before boot and boots the frame on them, with no store to read or write. */
function fixSettings(settings: Settings, configureFrame: (settings: Settings) => void): Settings {
  setSettings(settings);
  configureFrame(settings);
  return settings;
}
