// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The first import of main.ts, so Sentry is up before any other host module evaluates and catches their load errors.

import { initSentry, installGlobalErrorHandlers } from '@dotli/metrics';
import { disableAuthModal } from '@dotli/host-runtime';
import { showBrokenPage } from './broken-page.js';
import { loadingStore } from './state/loading.js';
import { reportIslandErrors } from './island-errors.js';

initSentry('host');
installGlobalErrorHandlers('host');
reportIslandErrors({
  loading: { store: loadingStore, gone: state => state.phase === 'gone' },
  standIns: { disableAuthModal, showBrokenPage },
});
