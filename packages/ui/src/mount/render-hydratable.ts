// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Server half of a hydrated root: renders `view` the way hydrateRoot
// (mount/root.ts) hydrates it. Server-only; imported by server entries such
// as components/shell/shell.server.tsx, never by client code.

import { renderToString, type JSX } from "@solidjs/web";
import { withHydrationBoundary } from "./hydration-boundary";

/**
 * Server-renders `view` inside {@link withHydrationBoundary}, the boundary
 * hydrateRoot hydrates inside (the keys must line up), and throws if `view`
 * throws, so a build-time prerender fails loudly instead of shipping nothing.
 *
 * The thrown error is the original one: without an `onError` policy, Solid's
 * production server build hands boundaries a sanitized
 * `Error("Internal Server Error")` instead (it is meant for responses a
 * visitor sees), which would leave a failed build with no cause.
 */
export function renderHydratableToString(
  view: () => JSX.Element,
  renderId: string,
): string {
  return renderToString(
    () =>
      withHydrationBoundary(view, (err) => {
        throw err;
      }),
    { renderId, onError: (err: unknown) => err },
  );
}
