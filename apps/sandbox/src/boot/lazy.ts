// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points, each its own chunk, so the sandbox's boot leaves them out.

import type * as sandboxChecker from '../checker/injectSandboxChecker.js';
import type * as pageUi from '../screens/pageUi.js';

/** The exports of the chunk the sandbox draws itself with. */
export type PageUiModule = typeof pageUi;

/** What the sandbox draws itself. A product that loads needs none of it. Rejects when the chunk cannot load. */
export function loadPageUi(): Promise<PageUiModule> {
  return import('../screens/pageUi.js');
}

/** The injector of the checker into a product's page. Rejects when the chunk cannot load. */
export function loadSandboxChecker(): Promise<typeof sandboxChecker> {
  return import('../checker/injectSandboxChecker.js');
}
