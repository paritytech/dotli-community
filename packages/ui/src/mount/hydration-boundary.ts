// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createComponent, Errored } from "solid-js";
import type { JSX } from "@solidjs/web";

/**
 * Renders `view` inside the error boundary a hydrated root needs, on the
 * server and the client alike: a boundary takes part in Solid's hydration
 * keys, so the server render (e.g. components/shell/shell.server.tsx) and
 * `hydrateRoot` (mount/root.ts) must both wrap the same view in it for the
 * keys to line up.
 *
 * On the client it is what keeps a failed hydration contained: an error that
 * escapes every boundary (such as the "Hydration Mismatch" a stripped
 * template raises, see mount/strip-client-templates-plugin.ts) halts Solid's
 * whole reactive system, every root on the page. `onError` gets the error
 * and the boundary renders nothing. On the server, `onError` should rethrow,
 * so a broken render fails the build instead of prerendering nothing.
 */
export function withHydrationBoundary(
  view: () => JSX.Element,
  onError: (err: unknown) => void,
): JSX.Element {
  return createComponent(Errored, {
    fallback: (err: () => unknown) => {
      onError(err());
      return null;
    },
    get children() {
      return view();
    },
  });
}
