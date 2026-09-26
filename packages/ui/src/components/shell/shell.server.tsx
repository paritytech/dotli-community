// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Server entry for the host shell prerender (see mount/prerender-plugin.ts).
// Loaded only through Vite's SSR module loading at build/dev time, never
// bundled into the client.

import { renderToString } from "@solidjs/web";

// Temporary stand-in that proves the prerender plumbing; replaced by the
// real Shell component.
function PrerenderPlaceholder() {
  return (
    <span class="shell-prerender-placeholder" hidden>
      prerendered
    </span>
  );
}

export function renderShell(): string {
  return renderToString(() => <PrerenderPlaceholder />, { renderId: "shell" });
}
