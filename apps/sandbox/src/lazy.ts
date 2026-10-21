// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points, each its own chunk, so the sandbox's boot leaves them out.

/** What the sandbox draws itself. A product that loads needs none of it. */
export const loadPageUi = () => import('./page-ui.js');
export type PageUiModule = Awaited<ReturnType<typeof loadPageUi>>;

/** Only a checker build injects it. */
export const loadSandboxChecker = () => import('./inject-checker.js');
