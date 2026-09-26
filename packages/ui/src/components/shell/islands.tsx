// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell's islands: its reactive pieces, loaded lazily after boot by
// mount/load-islands.ts. Shell.tsx keeps every piece's static markup, which
// is prerendered and hydrated as it is; here each island is client-rendered
// into a detached container and swapped in for those static nodes by id,
// wherever they are now (the landing page, ui.ts, moves the theme nodes out
// of `#shell`).
//
// An island's root container is that detached element, so Solid's delegated
// events (onClick, ...) would listen on a node outside the document: islands
// wire their events with native listeners in callback refs.

import type { JSX } from "@solidjs/web";
import { mountRoot } from "../../mount/root";
import { ThemeToggle } from "./ThemeToggle";

/**
 * Render `view` as the root `island:<name>` and swap each of its top-level
 * elements, identified by `ids`, in for the static element with the same
 * id. The swap happens in one go, so there is never a moment with two
 * elements per id or with half an island. If the island fails to render
 * (reported by mountRoot) or an id is missing on either side, the static
 * nodes stay and the island is unmounted. Focus on a static node moves to
 * its replacement.
 */
function mountIsland(
  name: string,
  view: () => JSX.Element,
  ids: string[],
): void {
  const container = document.createElement("div");
  const dispose = mountRoot(`island:${name}`, container, view);
  const pairs: [stale: Element, fresh: Element][] = [];
  for (const id of ids) {
    const stale = document.getElementById(id);
    const fresh = container.querySelector(`[id="${id}"]`);
    if (stale === null || fresh === null) {
      dispose();
      return;
    }
    pairs.push([stale, fresh]);
  }
  for (const [stale, fresh] of pairs) {
    const hadFocus = document.activeElement === stale;
    stale.replaceWith(fresh);
    if (hadFocus && fresh instanceof HTMLElement) {
      fresh.focus();
    }
  }
}

/** Mount every shell island over its static markup. */
export function mountIslands(): void {
  mountIsland("theme", () => <ThemeToggle />, [
    "theme-toggle",
    "theme-popover",
  ]);
}
