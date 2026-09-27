// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The roots that take turns filling `#app`, by name.
 *
 * `"loading"` is the loading overlay and `"page"` is the page content, such as
 * the landing page. Whatever replaces them (a product frame, an error page)
 * disposes them through here rather than removing their nodes, so their timers
 * and listeners stop with them.
 *
 * Solid-free on purpose: `ui.ts` registers the loading root, and the sandbox
 * imports `ui.ts` without Solid on its startup path.
 */
export type AppRootName = "loading" | "page";

const disposers = new Map<AppRootName, () => void>();

/**
 * Track `dispose` as the root called `name`. A root already registered under
 * that name is disposed first, if it is still live.
 */
export function registerAppRoot(name: AppRootName, dispose: () => void): void {
  disposeAppRoot(name);
  disposers.set(name, dispose);
}

/** Dispose the root called `name`. Does nothing if it is not live. */
export function disposeAppRoot(name: AppRootName): void {
  const dispose = disposers.get(name);
  if (dispose === undefined) {
    return;
  }
  // Dropped before it runs, so a disposer that reaches back here is a no-op.
  disposers.delete(name);
  dispose();
}

/** Dispose every live root: the page first, then the loading overlay. */
export function disposeAppRoots(): void {
  disposeAppRoot("page");
  disposeAppRoot("loading");
}
