// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Client half of the host shell prerender (mount/prerender-plugin.ts renders
// components/shell/shell.server.tsx into `#shell` at build time). The host
// calls hydrateShell() before any imperative shell code queries the shell's
// elements (apps/host/src/boot.ts), so those references are to the nodes
// Solid has claimed.
//
// The shell's client module carries no DOM templates (the host build strips
// them, see mount/strip-client-templates-plugin.ts), so it can only be
// hydrated, never client-rendered. A failed hydration therefore restores a
// snapshot of the prerendered markup (see hydrateRoot). That is valid
// because the shell is static: its reactive pieces are islands that
// mount/load-islands.ts swaps in over the static markup after boot, on the
// hydrated and the restored shell alike.

import { hydrateRoot } from "./root";
import { SHELL_RENDER_ID, Shell } from "../components/shell/Shell";

/**
 * Hydrate the prerendered shell in `#shell`. On success `#shell` gets
 * `data-hydrated="shell"`; if hydration fails (reported to Sentry, see
 * {@link hydrateRoot}) the prerendered markup is restored as it was and
 * `#shell` gets `data-hydrated="fallback"`. No-op if the page has no `#shell`.
 */
export function hydrateShell(): void {
  const container = document.getElementById("shell");
  if (container === null) {
    return;
  }
  const { hydrated } = hydrateRoot("shell", container, () => <Shell />, {
    renderId: SHELL_RENDER_ID,
  });
  container.dataset.hydrated = hydrated ? "shell" : "fallback";
}
