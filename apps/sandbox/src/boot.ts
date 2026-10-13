// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The first import of main.ts, so Sentry is up before any other sandbox module evaluates and catches their load errors.

import '@dotli/ui/styles.css';
import { initSentry, installGlobalErrorHandlers } from '@dotli/metrics';
import { listenForChunkFailures } from '@dotli/ui-widgets';

import { prefetchOverlays, showNotification } from './overlays.js';
import { reportChunkFailure } from './ui-reporter.js';

initSentry('sandbox');
installGlobalErrorHandlers('sandbox');
listenForChunkFailures({
  target: window,
  notify: showNotification,
  reload: () => {
    window.location.reload();
  },
  report: reportChunkFailure,
});
// In memory before a deploy could make later chunk loads fail.
prefetchOverlays();
