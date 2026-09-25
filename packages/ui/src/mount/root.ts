// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createComponent, Errored } from "solid-js";
import { render, type JSX } from "@solidjs/web";
import { captureException } from "@dotli/metrics/sentry";

const roots = new Map<string, () => void>();

// Per-root sets of already-reported error objects, keyed by root name.
// Solid can re-invoke an error boundary's `fallback` for the same thrown
// value (e.g. after a `reset()` that re-throws), so this dedupes rather than
// filing a duplicate Sentry issue for one error.
const reportedByRoot = new Map<string, WeakSet<object>>();

/**
 * Report `err` for root `name` to Sentry, once per distinct error object per
 * root. Non-object thrown values (a thrown string, number, etc.) cannot be
 * tracked in a `WeakSet` and are always reported.
 */
export function reportRootErrorOnce(err: unknown, name: string): void {
  if (typeof err !== "object" || err === null) {
    captureException(err, { root: name });
    return;
  }
  let reported = reportedByRoot.get(name);
  if (reported === undefined) {
    reported = new WeakSet();
    reportedByRoot.set(name, reported);
  }
  if (reported.has(err)) {
    return;
  }
  reported.add(err);
  captureException(err, { root: name });
}

/**
 * Render `view` into `container` as the named root. A throwing view is caught
 * by an error boundary, reported to Sentry with `{ root: name }` (once per
 * distinct error object), and renders nothing, so other roots and the page
 * keep working. Mounting a name that is already mounted disposes the old
 * root first.
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
          reportRootErrorOnce(err(), name);
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
  reportedByRoot.delete(name);
}
