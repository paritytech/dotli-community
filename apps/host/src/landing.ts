// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page's entry. It shares the shell's startup, but it loads no product. It is served on the root
// domain, so its copy is the main store, and it pairs on the page rather than in the window.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import { createRandomId } from '@dotli/shared';
import { runWhenIdle } from '@dotli/ui';
import { createReporter } from '@dotli/metrics';
import { startPage } from './startPage.js';
import { startHost } from './startHost.js';
import { reportBootFailure } from './reportBootFailure.js';

const report = createReporter({ flow: 'boot' });

async function main(): Promise<void> {
  startPage();
  // No nested dot.li.
  if (window.self !== window.top) {
    return;
  }

  const { bridge } = await startHost({ bootFlowId: createRandomId(), role: 'landing' });
  // Idle, so the core boot never competes with the page's first paint or its boot.
  runWhenIdle(() => {
    bridge.startSessionLease();
  }, 2000);
  report.log.event('Route: landing page');
}

main().catch(reportBootFailure);
