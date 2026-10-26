// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page's entry. It shares the shell's startup, but it registers no service worker and loads no product. It
// is served on the root domain, so its copy is the main store, and it pairs on the page rather than in the window.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import { log, randomId } from '@dotli/shared';
import { runWhenIdle } from '@dotli/ui';
import { reportBootFailure, startHost, startPage } from './startup.js';

async function main(): Promise<void> {
  startPage();
  // No nested dot.li.
  if (window.self !== window.top) {
    return;
  }

  const { bridgeModule } = await startHost(randomId(), { role: 'landing' });
  // Idle, so the core boot never competes with the page's first paint or its boot.
  runWhenIdle(() => {
    bridgeModule.startSessionLease();
  }, 2000);
  log.event('Route: landing page', { flow: 'boot' });
}

main().catch(reportBootFailure);
