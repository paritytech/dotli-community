// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Starts what every route opens on: the debug tools, the sandbox channel, the settings and the bridge.

import { startHost, type HostStartup } from './startHost.js';
// Right after the startup modules, so the page's start is marked once boot's dependencies have loaded.
import { PAGE_START } from './pageStart.js';
import { DEBUG, getActiveTldSuffix, isSandboxOrigin } from '@dotli/config';
import { startSandboxChannel, type SandboxChannel } from '@dotli/sandbox-wire';
import { createRandomId, formatElapsed, log, markHandled } from '@dotli/shared';
import { debugBus, resolveDebugMode } from '@dotli/truapi-debug';
import { loadTruapiDebugMount } from '@dotli/truapi-debug-ui';
import { loadDebugPanelHost, loadHostBridge } from './lazy.js';
import { listenForSandboxDebugEvents } from './listenForSandboxDebugEvents.js';
import { reportSandboxHandlerFailure } from './reportSandboxHandlerFailure.js';
import type { ProductFrame } from './runtime/createProductFrame.js';
import type { PageRole } from './runtime/pageRole.js';
import type { ShellRoute } from './shellRoute.js';
import { startDebugPanel } from './startDebugPanel.js';
import { startMainThreadMonitor } from './startMainThreadMonitor.js';
import { startShellState } from './startShellState.js';
import { urlPillState } from './state/urlPillState.js';
import { watchSandboxLoad, type SandboxLoad } from './watchSandboxLoad.js';

/** What every route opens on once the host is up. */
export type Shell = {
  /** The debug panel's flow for this page load, and the Sentry trace's id. */
  flowId: string;
  sandboxChannel: SandboxChannel;
  /** What the sandbox said about the page's load. */
  sandboxLoad: SandboxLoad;
  startup: HostStartup;
  productFrame: ProductFrame;
};

/**
 * Starts the debug tools, the sandbox channel, the settings and the bridge. It sets the page's network before its
 * first await, and the shared settings read after that never change it.
 */
export async function startShell(route: ShellRoute, role: PageRole): Promise<Shell> {
  log.debug(`[dot.li perf] main() started (${formatElapsed(PAGE_START)})`);
  // From the URL alone, before any await, so the URL bar paints with the page.
  if (route.kind === 'preview' || route.kind === 'localhost') {
    urlPillState.showLocalhost(route.host);
  }

  // The panel's heavy chunk loads only on opt-in. Otherwise the bus stays off and every emit returns early.
  const debugMode = resolveDebugMode(window, DEBUG);
  if (debugMode.enabled) {
    debugBus.enableBuffering();
    // The describer reports its own failed load, and the boot reports the bridge's.
    void markHandled(loadHostBridge().then(bridge => bridge.wireDescriber.preload()));
    void startDebugPanel({
      load: loadTruapiDebugMount,
      host: async () => (await loadDebugPanelHost()).debugPanelHost,
      startCollapsed: !debugMode.explicit,
    });
  }

  // The only window listener for sandbox frames, so the origin rule is applied in one place.
  const sandboxChannel = startSandboxChannel({
    target: window,
    isTrustedOrigin: isSandboxOrigin,
    onUntrusted(type, origin) {
      log.warn(`[dot.li] Rejected ${type} from non-sandbox origin: ${origin}`);
    },
    report: reportSandboxHandlerFailure,
  });
  // The page never stops watching its sandbox's load early, so the watch's `dispose` goes unused.
  const sandboxLoad = watchSandboxLoad(sandboxChannel);

  const flowId = createRandomId();
  if (debugMode.enabled) {
    // The page never stops the monitor or the sandbox's debug events early, so their cleanups go unused.
    startMainThreadMonitor({ flowId, emit: debugBus.emit, watch: debugBus.watch });
    listenForSandboxDebugEvents(sandboxChannel, debugBus.emit);
  }

  const startup = await startHost({
    bootFlowId: flowId,
    role,
    emitDotliDebugEvent: debugBus.emit,
    startShellState() {
      startShellState();
      // Drawn from this origin's settings and the link's, set just before and with no await since, so the URL bar
      // paints with the page. The product's load draws it again once the shared store has answered.
      if (route.kind === 'product') {
        urlPillState.showProduct(route.label, getActiveTldSuffix());
      }
    },
  });
  const productFrame = startup.bridge.startProductFrame(sandboxChannel);
  // With the path as the settings left it. A preview is not announced.
  if (route.kind !== 'preview') {
    debugBus.emit({
      layer: 'boot',
      event: 'url_parsed',
      flowId,
      timestamp: Date.now(),
      payload: {
        label: route.kind === 'product' ? route.label : null,
        localhostHost: route.kind === 'localhost' ? route.host : null,
        deepPath: window.location.pathname + window.location.search,
      },
    });
  }
  return { flowId, sandboxChannel, sandboxLoad, startup, productFrame };
}
