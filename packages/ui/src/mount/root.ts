// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createComponent, Errored } from "solid-js";
import { render, type JSX } from "@solidjs/web";
import { captureException } from "@dotli/metrics";
import { disposeAppRoot, registerAppRoot } from "./app-roots.js";

export interface MountRootOptions {
  /**
   * Runs inside the error boundary on the first render error, right after the
   * report, while the view's nodes are still where they were.
   */
  onError?: () => void;
  /**
   * Runs once after the first render error, a microtask later (a root cannot
   * be disposed from inside its own error boundary), once the root is
   * disposed.
   */
  onBroken?: () => void;
  /** Take `container` out of the page when the root is disposed. */
  removeContainer?: boolean;
}

/**
 * Render `view` into `container` as the named root, tracked with the app
 * roots (disposeAppRoot disposes it by name). Mounting a name that is already
 * mounted disposes the old root first. The returned disposer may run more
 * than once.
 *
 * A throwing view is caught by an error boundary and renders nothing, so
 * other roots and the page keep working. The first error is reported to
 * Sentry with `{ root: name }`; the root is then broken: it is disposed a
 * microtask later, then `options.onBroken` runs, so the owner can recover.
 * Solid may re-invoke the fallback, but a broken root is only handled once.
 */
export function mountRoot(
  name: string,
  container: HTMLElement,
  view: () => JSX.Element,
  options: MountRootOptions = {},
): () => void {
  disposeAppRoot(name);
  let broken = false;
  const disposeView = render(
    () =>
      createComponent(Errored, {
        fallback: (err: () => unknown) => {
          if (!broken) {
            broken = true;
            captureException(err(), { root: name });
            options.onError?.();
            queueMicrotask(() => {
              dispose();
              options.onBroken?.();
            });
          }
          return null;
        },
        get children() {
          return view();
        },
      }),
    container,
  );
  const dispose = registerAppRoot(name, () => {
    disposeView();
    if (options.removeContainer === true) {
      container.remove();
    }
  });
  return dispose;
}
