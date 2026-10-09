// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The first import of main.ts, so Sentry is up before any other host module evaluates and catches their load errors.

import { initSentry, installGlobalErrorHandlers } from '@dotli/metrics';
import { reportIslandErrors } from '@dotli/ui';

initSentry('host');
installGlobalErrorHandlers('host');
reportIslandErrors();
