// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page's entry. It signs in through the same core as the shell, so it shares the shell's startup, but it
// registers no service worker and loads no product.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import { log } from '@dotli/shared';
import { DEBUG } from '@dotli/config';
import { loadTruapiDebugMount } from '@dotli/ui';
import { loadDotliDebugBus } from '@dotli/truapi-debug';
import { createBootFlowId, reportBootFailure, resolveTruapiDebugMode, startHost } from './startup.js';

async function main(): Promise<void> {
  // No nested dot.li.
  if (window.self !== window.top) {
    return;
  }

  const debugMode = resolveTruapiDebugMode();
  const { emitDotliDebugEvent, enableDotliDebugBuffering } = await loadDotliDebugBus();
  if (debugMode.enabled) {
    enableDotliDebugBuffering();
  }
  const { bridgeModule } = await startHost(createBootFlowId(), emitDotliDebugEvent);
  if (debugMode.enabled) {
    void loadTruapiDebugMount().then(({ setupTruapiDebugPanel }) => {
      setupTruapiDebugPanel({
        startCollapsed: !debugMode.explicit,
        ...(DEBUG ? { experimentalWallet: bridgeModule.experimentalWalletControls } : {}),
      });
      log.event('TrUAPI debug panel enabled', { flow: 'boot' });
    });
  }
  performance.mark('dotli:main:end');
  log.event('Route: landing page', { flow: 'boot' });
}

main().catch(reportBootFailure);
