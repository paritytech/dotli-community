// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every live root, by name: the Solid roots mountRoot mounts (`"chat"`,
 * `"island:theme"`, ...) and the roots that take turns filling `#app`.
 *
 * `"loading"` is the loading overlay and `"page"` is the page content, such as
 * the landing page. Whatever replaces them (a product frame, an error page)
 * disposes them through here rather than removing their nodes, so their timers
 * and listeners stop with them.
 *
 * Solid-free on purpose: `loading-controller.ts` registers the loading root
 * on the host's startup path, and the sandbox imports `ui.ts`, which disposes
 * the roots, without Solid on its startup path.
 */
import { captureException } from '@dotli/metrics';

const disposers = new Map<string, () => void>();

/**
 * Track `dispose` as the root called `name`. A root already registered under
 * that name is disposed first, if it is still live. Returns the root's own
 * disposer: it runs `dispose` once, however often it is called, and drops the
 * root from here unless another has taken the name since.
 */
export function registerAppRoot(name: string, dispose: () => void): () => void {
  disposeAppRoot(name);
  // Again, for a root the old disposer registered under this name on its way
  // out. It would otherwise be overwritten below without being disposed.
  disposeAppRoot(name);
  let done = false;
  const disposeThis = (): void => {
    if (disposers.get(name) === disposeThis) {
      disposers.delete(name);
    }
    if (!done) {
      done = true;
      dispose();
    }
  };
  disposers.set(name, disposeThis);
  return disposeThis;
}

/**
 * Dispose the root called `name`. Does nothing if it is not live.
 *
 * Never throws. A failing disposer is reported and the root still counts as
 * disposed, so the next root is disposed and an error page replacing them
 * still renders.
 */
export function disposeAppRoot(name: string): void {
  try {
    disposers.get(name)?.();
  } catch (err) {
    captureException(err, { kind: 'app_root_dispose_error', root: name });
  }
}

/** Dispose the roots in `#app`: the page first, then the loading overlay. */
export function disposeAppRoots(): void {
  disposeAppRoot('page');
  disposeAppRoot('loading');
}
