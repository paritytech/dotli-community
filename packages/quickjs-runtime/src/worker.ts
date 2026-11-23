// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The Web Worker that runs one QuickJS VM for the page that starts it. The page builds the worker from this module
// and drives it through the client the package's main entry exports.

import { serveQuickJsWorker } from './serveQuickJsWorker.js';

serveQuickJsWorker({ scope: self });
