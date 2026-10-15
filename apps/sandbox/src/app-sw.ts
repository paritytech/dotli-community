// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { startAppServiceWorker } from './app-service-worker.js';

startAppServiceWorker({ scope: self, indexedDB, fetch, devServer: import.meta.env.DEV });
