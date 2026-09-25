// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createComponent, Errored } from "solid-js";
import { render, type JSX } from "@solidjs/web";
import { captureException } from "@dotli/metrics/sentry";

const roots = new Map<string, () => void>();

/**
 * Render `view` into `container` as the named root. A throwing view is caught
 * by an error boundary, reported to Sentry with `{ root: name }`, and renders
 * nothing, so other roots and the page keep working. Mounting a name that is
 * already mounted disposes the old root first.
 */
export function mountRoot(
  name: string,
  container: HTMLElement,
  view: () => JSX.Element,
): () => void {
  disposeRoot(name);
  const dispose = render(
    () =>
      createComponent(Errored, {
        fallback: (err: () => unknown) => {
          captureException(err(), { root: name });
          return null;
        },
        get children() {
          return view();
        },
      }),
    container,
  );
  const disposeThis = (): void => {
    if (roots.get(name) === disposeThis) {
      roots.delete(name);
    }
    dispose();
  };
  roots.set(name, disposeThis);
  return disposeThis;
}

/** Unmount the named root. No-op if it is not mounted. */
export function disposeRoot(name: string): void {
  roots.get(name)?.();
}
