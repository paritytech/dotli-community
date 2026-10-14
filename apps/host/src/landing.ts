// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page's entry. It signs in through the same core as the shell, so it shares the shell's startup, but it
// registers no service worker and loads no product.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import { log, randomId } from '@dotli/shared';
import { reportBootFailure, startHost, startPage } from './startup.js';

async function main(): Promise<void> {
  startPage();
  // No nested dot.li.
  if (window.self !== window.top) {
    return;
  }

  await startHost(randomId());
  log.event('Route: landing page', { flow: 'boot' });
}

main().catch(reportBootFailure);
