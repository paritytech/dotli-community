// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Errored } from "solid-js";
import { isServer, type JSX } from "@solidjs/web";

/**
 * A reactive part of the static host shell (Shell.tsx), inside its own error
 * boundary. Without it, an error an island raises after hydration would reach
 * the shell's hydration boundary (mount/hydration-boundary.ts), which renders
 * nothing: the whole shell would go blank for one broken piece. Here the
 * failing island alone renders nothing, and the error is reported to Sentry
 * once with `{ root: "shell", island: name }`.
 *
 * Shell.tsx renders it on the server and the client alike: a boundary takes
 * part in Solid's hydration keys, so it must be in both renders for the keys
 * to line up. On the server (the build-time prerender) the fallback renders
 * nothing and reports nothing: the error still fails the build, since
 * renderHydratableToString (mount/render-hydratable.ts) rethrows every error
 * Solid contains during the render.
 *
 * On the client the boundary also catches a hydration mismatch inside the
 * island: the island goes blank and is reported, while the rest of the shell
 * stays hydrated (hydrateRoot's snapshot fallback does not run for it).
 *
 * The island's markup comes from its child component's own module, which
 * keeps its client templates: Shell.tsx has its templates stripped
 * (mount/strip-client-templates-plugin.ts), and an island renders nodes
 * after hydration.
 */
export function Island(props: {
  name: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <Errored
      fallback={(err: () => unknown) => {
        if (isServer) {
          // Rethrowing would not help: Solid's server render contains it.
          // renderHydratableToString fails the build instead.
          return null;
        }
        const error = err();
        const island = props.name;
        // Loaded on use rather than imported: the server loads this module
        // too, to prerender, and Sentry's module needs browser globals. The
        // client already has it (mount/hydrate-shell.tsx imports it).
        void import("../../mount/root").then(({ reportRootErrorOnce }) => {
          // "shell" is the root name mount/hydrate-shell.tsx hydrates under.
          reportRootErrorOnce(error, "shell", { island });
        });
        return null;
      }}
    >
      {props.children}
    </Errored>
  );
}
