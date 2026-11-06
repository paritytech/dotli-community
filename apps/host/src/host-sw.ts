// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// An earlier release precached the shell in a service worker. This worker retires that one for visitors who still have
// it.

/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { retireShellWorker } from './retireShellWorker.js';

retireShellWorker({ scope: self, caches });
