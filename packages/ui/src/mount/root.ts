// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createComponent, Errored, untrack } from "solid-js";
import { hydrate, render, type JSX } from "@solidjs/web";
import { captureException } from "@dotli/metrics/sentry";
import { withHydrationBoundary } from "./hydration-boundary";

const roots = new Map<string, () => void>();

// Per-root sets of already-reported error objects, keyed by root name.
// Solid can re-invoke an error boundary's `fallback` for the same thrown
// value (e.g. after a `reset()` that re-throws), so this dedupes rather than
// filing a duplicate Sentry issue for one error.
const reportedByRoot = new Map<string, WeakSet<object>>();

/**
 * Report `err` for root `name` to Sentry, once per distinct error object per
 * root, with `{ root: name }` plus `tags`. Non-object thrown values (a thrown
 * string, number, etc.) cannot be tracked in a `WeakSet` and are always
 * reported.
 */
export function reportRootErrorOnce(
  err: unknown,
  name: string,
  tags: Record<string, string> = {},
): void {
  if (typeof err !== "object" || err === null) {
    captureException(err, { root: name, ...tags });
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
  captureException(err, { root: name, ...tags });
}

export interface MountRootOptions {
  /** Called after a render error has been reported. */
  onError?: (err: unknown) => void;
}

/**
 * Render `view` into `container` as the named root. A throwing view is caught
 * by an error boundary, reported to Sentry with `{ root: name }` (once per
 * distinct error object), and renders nothing, so other roots and the page
 * keep working. Mounting a name that is already mounted disposes the old
 * root first. `options.onError` runs after the report, so a root can settle
 * work that depended on it.
 */
export function mountRoot(
  name: string,
  container: HTMLElement,
  view: () => JSX.Element,
  options: MountRootOptions = {},
): () => void {
  disposeRoot(name);
  const dispose = render(
    () =>
      createComponent(Errored, {
        fallback: (err: () => unknown) => {
          const error = err();
          reportRootErrorOnce(error, name);
          options.onError?.(error);
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

export interface HydrateRootOptions extends MountRootOptions {
  /** The `renderId` the server render of `view` used. */
  renderId: string;
}

/** Outcome of {@link hydrateRoot}. */
export interface HydratedRoot {
  /** Unmounts the root (a no-op after a failed hydration). */
  dispose: () => void;
  /**
   * `true` when Solid claimed the server-rendered nodes in place; `false`
   * when hydration failed and the server-rendered nodes were restored.
   */
  hydrated: boolean;
}

// Solid's hydration runtime reads this global, which a full server-rendered
// document defines in an inline `generateHydrationScript()` tag (it also
// queues events fired before hydration, for replay into Solid's delegated
// handlers). A prerendered fragment has no such tag and nothing to replay,
// so an empty registry is enough.
function ensureHydrationGlobal(): void {
  const global = globalThis as { _$HY?: unknown };
  global._$HY ??= { events: [], completed: new WeakSet(), r: {} };
}

// Every node `value` resolves to, the way Solid inserts it: arrays flatten,
// accessors are read.
function resolvedNodes(value: unknown, into: Node[] = []): Node[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      resolvedNodes(item, into);
    }
  } else if (typeof value === "function") {
    resolvedNodes(untrack(value as () => unknown), into);
  } else if (value instanceof Node) {
    into.push(value);
  }
  return into;
}

/**
 * Hydrate the server-rendered content of `container` as the named root:
 * Solid claims the existing nodes instead of creating new ones, so imperative
 * code holding references to them keeps working.
 *
 * The server render must use `renderHydratableToString`
 * (mount/render-hydratable.ts): the hydrate pass runs inside the same
 * {@link withHydrationBoundary}, and a boundary on one side only would shift
 * Solid's hydration keys.
 *
 * Hydration counts as failed when it throws (the boundary catches it), or
 * when the view did not resolve to exactly the elements the server rendered
 * into `container`, in order: for markup it cannot match, Solid can create
 * detached replacement nodes instead, which would silently cut imperative
 * references loose. A failure is reported to Sentry with `{ root: name,
 * kind: "hydration_failed" }` and `container` gets back a copy of its
 * server-rendered children, taken before hydrating. An error the hydrated
 * view raises later is caught by the same boundary (which then renders
 * nothing) and reported once with `{ root: name, kind: "render_error" }`,
 * followed by `options.onError`.
 *
 * That snapshot fallback is valid only while `view` is static (the host
 * shell): the restored nodes are plain DOM that Solid does not own, so any
 * reactive part would be dead. It is also what lets the shell ship without
 * its client templates (mount/strip-client-templates-plugin.ts), which only
 * a client render would use. The shell's reactive pieces are islands mounted
 * separately over its static markup (mount/load-islands.ts), whichever way
 * this went.
 */
export function hydrateRoot(
  name: string,
  container: HTMLElement,
  view: () => JSX.Element,
  options: HydrateRootOptions,
): HydratedRoot {
  disposeRoot(name);
  const serverElements = [...container.children];
  const snapshot = [...container.childNodes].map((node) =>
    node.cloneNode(true),
  );
  let produced: unknown;
  let dispose: (() => void) | undefined;
  let failure: unknown;
  let hydrating = true;
  try {
    ensureHydrationGlobal();
    dispose = hydrate(
      () =>
        withHydrationBoundary(
          () => {
            produced = view();
            return produced as JSX.Element;
          },
          (err) => {
            if (hydrating) {
              failure ??= err;
              return;
            }
            // Raised by the hydrated view later on: the boundary shows
            // nothing in its place, so report it like mountRoot does.
            reportRootErrorOnce(err, name, { kind: "render_error" });
            options.onError?.(err);
          },
        ),
      container,
      { renderId: options.renderId },
    );
    if (failure === undefined) {
      const claimed = resolvedNodes(produced).filter(
        (node) => node instanceof Element,
      );
      const matches =
        claimed.length === serverElements.length &&
        claimed.every(
          (node, i) =>
            node === serverElements[i] && node.parentNode === container,
        );
      if (!matches) {
        failure = new Error(
          `[hydrate] root "${name}" did not claim its server-rendered nodes: the server rendered ${String(serverElements.length)} top-level element(s) and the view resolved to ${String(claimed.length)}, which are not those same nodes in the same order`,
        );
      }
    }
  } catch (err) {
    failure ??= err;
  } finally {
    hydrating = false;
  }
  if (failure !== undefined) {
    dispose?.();
    captureException(failure, { root: name, kind: "hydration_failed" });
    options.onError?.(failure);
    container.replaceChildren(...snapshot);
    // Nothing to unmount: the restored nodes are not a Solid root.
    return { dispose: () => undefined, hydrated: false };
  }
  const hydratedDispose = dispose as () => void;
  const disposeThis = (): void => {
    if (roots.get(name) === disposeThis) {
      roots.delete(name);
    }
    hydratedDispose();
  };
  roots.set(name, disposeThis);
  return { dispose: disposeThis, hydrated: true };
}
