// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The first import of main.ts, so Sentry is up before any other sandbox module evaluates and catches their load errors.

import { initSentry, installGlobalErrorHandlers } from '@dotli/metrics';

initSentry('sandbox');
installGlobalErrorHandlers('sandbox');
