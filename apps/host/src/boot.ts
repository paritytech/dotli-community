// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The first import of main.ts. A module's imports all run before its own
// body, in import order, so this runs before any other module of the host
// evaluates. Sentry starts first so that an error thrown while those modules
// load, or later, reaches it, a shell island failing to hydrate included.

import { initSentry, installGlobalErrorHandlers } from '@dotli/metrics';
import { reportIslandErrors } from '@dotli/ui';

initSentry('host');
installGlobalErrorHandlers('host');
reportIslandErrors();
