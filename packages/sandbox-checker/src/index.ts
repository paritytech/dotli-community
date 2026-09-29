// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Public API of @dotli/sandbox-checker. Other workspace packages import only from here.
// Every other module under src/ is private to the package.
export { loadSandboxChecker, type SandboxCheckerModule } from "./lazy.js";
