// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The first import of main.ts. A module's imports all run before its own
// body, in import order, so this runs before any other module of the host
// evaluates. Sentry starts first so that an error thrown while those modules
// load, or later, reaches it. The shell's islands (its reactive pieces) then
// start loading, off the startup bundle, as early as possible; they swap in
// over the prerendered static markup when their chunk arrives, and a click
// on one of their triggers before that is held and replayed.

import { initSentry, installGlobalErrorHandlers } from '@dotli/metrics';
import { ensureIslands } from '@dotli/ui';

initSentry('host');
installGlobalErrorHandlers('host');
void ensureIslands();
