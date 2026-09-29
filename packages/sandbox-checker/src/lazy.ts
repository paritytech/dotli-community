// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points of the package, re-exported from index.ts. Each module
// is its own chunk, fetched on first call. They live apart from the barrel
// so index.ts stays pure re-exports, which rolldown's lazy barrel
// optimization needs to leave unused re-exports out of an importer's chunk.

import type * as SandboxCheckerNamespace from './sandbox-checker.js';

export type SandboxCheckerModule = typeof SandboxCheckerNamespace;
export const loadSandboxChecker = (): Promise<SandboxCheckerModule> => import('./sandbox-checker.js');
