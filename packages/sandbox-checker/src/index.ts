// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export { loadSandboxChecker } from './lazy.js';
// The app's service worker builds as one file, so it takes the injector directly.
export { injectSandboxChecker } from './sandbox-checker.js';
