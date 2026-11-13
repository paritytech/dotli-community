// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Starts what every route opens on: the debug tools, the sandbox channel, the settings and the bridge.

import { startHost } from './startHost.js';
// Right after the startup modules, so the page's start is marked once boot's dependencies have loaded.
import { PAGE_START } from './pageStart.js';
import { DEBUG, getActiveTldSuffix, isSandboxOrigin } from '@dotli/config';
import { startSandboxChannel } from '@dotli/sandbox-wire';
import { createRandomId, formatElapsed, log, markHandled } from '@dotli/shared';
import { debugBus, resolveDebugMode } from '@dotli/truapi-debug';
import { loadTruapiDebugMount } from '@dotli/truapi-debug-ui';
import { loadDebugPanelHost, loadHostBridge } from './lazy.js';
import { listenForSandboxDebugEvents } from './listenForSandboxDebugEvents.js';
import { reportSandboxHandlerFailure } from './reportSandboxHandlerFailure.js';
import type { PageRole } from './runtime/pageRole.js';
import { isLocalTarget, type ShellRoute } from './shellRoute.js';
import { startDebugPanel } from './startDebugPanel.js';
import { startMainThreadMonitor } from './startMainThreadMonitor.js';
import { startShellState as startChromeState } from './startShellState.js';
import { urlPillState } from './state/urlPillState.js';
import { watchSandboxLoad } from './watchSandboxLoad.js';

/** What every route opens on once the host is up. */
export type Shell = Awaited<ReturnType<typeof startShell>>;

/**
 * Starts the debug tools, the sandbox channel, the settings and the bridge. It sets the page's network before its
 * first await, and the shared settings read after that never change it. Rejects as the host start does, with what the
 * settings boot or the bridge load threw.
 */
export async function startShell(route: Exclude<ShellRoute, { kind: 'nested' }>, role: PageRole) {
  log.debug(`[dot.li perf] main() started (${formatElapsed(PAGE_START)})`);
  // From the URL alone, before any await, so the URL bar paints with the page.
  if (isLocalTarget(route)) {
    urlPillState.showLocalhost(route.host);
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

  // The panel's heavy chunk loads only on opt-in. Otherwise the bus stays off and every emit returns early.
  const debugMode = resolveDebugMode(window, DEBUG);
  if (debugMode.enabled) {
    debugBus.enableBuffering();
    // The describer reports its own failed load, and the boot reports the bridge's.
    void markHandled(loadHostBridge().then(bridge => bridge.wireDescriber.preload()));
    void startDebugPanel({
      load: loadTruapiDebugMount,
      host: loadDebugPanelHost,
      startCollapsed: !debugMode.explicit,
    });
    // The page never stops the monitor or the sandbox's debug events early, so their cleanups go unused.
    startMainThreadMonitor({ flowId, emit: debugBus.emit, watch: debugBus.watch });
    listenForSandboxDebugEvents(sandboxChannel, debugBus.emit);
  }

  const startup = await startHost({
    bootFlowId: flowId,
    role,
    emitDotliDebugEvent: debugBus.emit,
    startShellState() {
      startChromeState();
      // Drawn from this origin's settings and the link's, set just before and with no await since, so the URL bar
      // paints with the page. The product's load draws it again once the shared store has answered.
      if (route.kind === 'product') {
        urlPillState.showProduct(route.label, getActiveTldSuffix());
      }
    },
  });
  const productFrame = startup.bridge.startProductFrame(sandboxChannel);
  // With the path as the settings left it. The event names a product or a localhost target, and has no field for a
  // preview.
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
  return {
    /** The debug panel's flow for this page load, and the Sentry trace's id. */
    flowId,
    sandboxChannel,
    /** What the sandbox said about the page's load. */
    sandboxLoad,
    startup,
    productFrame,
  };
}
