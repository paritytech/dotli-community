// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Server entry for the host shell prerender (see mount/prerender-plugin.ts).
// Loaded only through Vite's SSR module loading at build/dev time, never
// bundled into the client.

import { renderToString } from "@solidjs/web";
import { Shell } from "./Shell";

/**
 * The static shell markup for index.html. The client never hydrates it, so
 * the render carries no hydration keys; an error in Shell fails the build.
 */
export function renderShell(): string {
  return renderToString(() => <Shell />);
}
