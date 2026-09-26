// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Server entry for the host shell prerender (see mount/prerender-plugin.ts).
// Loaded only through Vite's SSR module loading at build/dev time, never
// bundled into the client.

import { renderHydratableToString } from "../../mount/render-hydratable";
import { SHELL_RENDER_ID, Shell } from "./Shell";

export function renderShell(): string {
  return renderHydratableToString(() => <Shell />, SHELL_RENDER_ID);
}
