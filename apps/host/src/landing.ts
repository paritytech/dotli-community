// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page's entry. It signs in through the same core as the shell, so it shares the shell's startup, but it
// registers no service worker and loads no product.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import { log } from '@dotli/shared';
import { reportBootFailure, startHost } from './startup.js';

async function main(): Promise<void> {
  // No nested dot.li.
  if (window.self !== window.top) {
    return;
  }

  const { bootFlowId, emitDotliDebugEvent } = await startHost();

  log.event('Route: landing page', { flow: 'boot' });
  performance.mark('dotli:main:end');
  emitDotliDebugEvent({
    layer: 'boot',
    event: 'landing_page_shown',
    flowId: bootFlowId,
    timestamp: Date.now(),
    payload: {},
  });
}

main().catch(reportBootFailure);
