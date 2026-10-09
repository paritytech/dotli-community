// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Apart from index.ts so the barrel stays pure re-exports, which rolldown needs to drop unused ones.

import type * as SandboxCheckerNamespace from './sandbox-checker.js';

export type SandboxCheckerModule = typeof SandboxCheckerNamespace;
export const loadSandboxChecker = (): Promise<SandboxCheckerModule> => import('./sandbox-checker.js');
