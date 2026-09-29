// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Public API of @dotli/sandbox-checker. Other workspace packages import only from here;
// every other module under src/ is private to the package.

// Lazy entry points. Each module is its own chunk, fetched on first call;
// a static re-export here would pull it into every importer's bundle.
export type SandboxCheckerModule = typeof import("./sandbox-checker.js");
export const loadSandboxChecker = (): Promise<SandboxCheckerModule> =>
  import("./sandbox-checker.js");
