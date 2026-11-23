// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page's entry. It shares the shell's startup, but it loads no product. It is served on the root
// domain, so its copy is the main store, and it pairs on the page rather than in the window.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import { createRandomId } from '@dotli/shared';
import { getProtocolClient } from '@dotli/protocol';
import { runWhenIdle } from '@dotli/ui';
import { createReporter } from '@dotli/metrics';
import { startPage } from './startPage.js';
import { startHost } from './startHost.js';
import { reportBootFailure } from './reportBootFailure.js';
import { framePeerCounts } from '../features/network/index.js';
import { startKeyboardPin } from '../features/landing/index.js';
import { updateReload } from '../kit/createUpdateReload.js';

const report = createReporter({ flow: 'boot' });

async function main(): Promise<void> {
  startPage();
  // Before boot, which enables the name field, so the pin is live before the field can take focus.
  startKeyboardPin();
  // No nested dot.li.
  if (window.self !== window.top) {
    return;
  }

  // Before the frame boots, since the feed keeps no replay and the frame replays its counts when the feed opens.
  framePeerCounts.start();
  // Before the frame boots, which replays a mismatch it already met. The page hears it for its whole life, so the stop
  // goes unused.
  getProtocolClient().frame.subscribeVersionMismatch(updateReload.start);
  const { bridge } = await startHost({ bootFlowId: createRandomId(), role: 'landing' });
  // Idle, so the core boot never competes with the page's first paint or its boot.
  runWhenIdle(() => {
    bridge.startSessionLease();
  }, 2000);
  report.log.event('Route: landing page');
}

main().catch(reportBootFailure);
