// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A Shell.tsx look-alike with one island: static markup around a reactive
// child, the way sub-project 4b inserts islands into the host shell
// (strip-client-templates-plugin.test.ts, island.test.tsx).

import type { JSX } from "@solidjs/web";
import { Island } from "@dotli/ui/components/shell/Island";
import { Counter } from "./Counter";

export const ISLAND_SHELL_RENDER_ID = "island-fixture";

export function IslandShell(): JSX.Element {
  return (
    <>
      <div id="fixture-bar" class="fixture-static-bar">
        <a id="fixture-home" href="/">
          <svg width="16" height="18" viewBox="0 0 16 18">
            <path d="M8 0L16 9L8 18L0 9Z" />
          </svg>
        </a>
        <Island name="counter">
          <Counter />
        </Island>
        <span id="fixture-after">after</span>
      </div>
      <div id="fixture-panel">static panel</div>
    </>
  );
}
