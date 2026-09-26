// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Server entry for IslandShell.tsx, rendered the way shell.server.tsx renders
// the host shell (island.test.tsx).

import { renderHydratableToString } from "@dotli/ui/mount/render-hydratable";
import { ISLAND_SHELL_RENDER_ID, IslandShell } from "./IslandShell";

export function renderIslandShell(): string {
  return renderHydratableToString(
    () => <IslandShell />,
    ISLAND_SHELL_RENDER_ID,
  );
}
