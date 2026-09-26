// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Server entry for the host shell prerender (see mount/prerender-plugin.ts).
// Loaded only through Vite's SSR module loading at build/dev time, never
// bundled into the client.

import { renderToString } from "@solidjs/web";
import { withHydrationBoundary } from "../../mount/hydration-boundary";
import { SHELL_RENDER_ID, Shell } from "./Shell";

export function renderShell(): string {
  // The same boundary hydrateRoot hydrates inside (keys must line up); a
  // render error is rethrown so the build fails instead of shipping an empty
  // shell.
  return renderToString(
    () =>
      withHydrationBoundary(
        () => <Shell />,
        (err) => {
          throw err;
        },
      ),
    { renderId: SHELL_RENDER_ID },
  );
}
