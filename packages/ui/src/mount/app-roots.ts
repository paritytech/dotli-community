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
import { captureException } from "@dotli/metrics/sentry";

export type AppRootName = "loading" | "page";

const disposers = new Map<AppRootName, () => void>();

/**
 * Track `dispose` as the root called `name`. A root already registered under
 * that name is disposed first, if it is still live.
 */
export function registerAppRoot(name: AppRootName, dispose: () => void): void {
  disposeAppRoot(name);
  // Again, for a root the old disposer registered under this name on its way
  // out. It would otherwise be overwritten below without being disposed.
  disposeAppRoot(name);
  disposers.set(name, dispose);
}

/**
 * Dispose the root called `name`. Does nothing if it is not live.
 *
 * Never throws. A failing disposer is reported and the root still counts as
 * disposed, so the next root is disposed and an error page replacing them
 * still renders.
 */
export function disposeAppRoot(name: AppRootName): void {
  const dispose = disposers.get(name);
  if (dispose === undefined) {
    return;
  }
  // Dropped before it runs, so a disposer that reaches back here is a no-op.
  disposers.delete(name);
  try {
    dispose();
  } catch (err) {
    captureException(err, { kind: "app_root_dispose_error", root: name });
  }
}

/** Dispose every live root: the page first, then the loading overlay. */
export function disposeAppRoots(): void {
  disposeAppRoot("page");
  disposeAppRoot("loading");
}
