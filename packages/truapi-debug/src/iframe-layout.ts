// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Product-iframe layout adjustment so the TrUAPI debug panel never
// overlays the host's rendered content.
//
// Solid-free: consumed by the Solid truapi-debug components in
// `packages/ui/src/components/truapi-debug/`, so it must not import
// `@dotli/ui` or `solid-js`.

import type { DockPosition } from "./dock-storage.ts";

export interface IframeLayoutInput {
  collapsed: boolean;
  dock: DockPosition;
  /** Panel's rendered width in px (e.g. `panel.offsetWidth`). Only consulted for the right dock. */
  width: number;
  /** Panel's rendered height in px (e.g. `panel.offsetHeight`). Only consulted for the bottom dock. */
  height: number;
}

/** Adjust the currently-mounted product iframe so the panel doesn't overlay it. */
export function adjustIframeForPanel(input: IframeLayoutInput): void {
  const iframe = document.querySelector<HTMLIFrameElement>("iframe");
  if (iframe === null) {
    return;
  }
  const hasTopbar = document.getElementById("topbar") !== null;
  const topOffset = hasTopbar ? 56 : 0;
  if (input.dock === "right") {
    iframe.style.height = `calc(100dvh - ${String(topOffset)}px)`;
    // When collapsed, the 32px header bar overlays the top-right corner
    // of the iframe rather than reserving a full-height column. Mirrors
    // how bottom-dock collapse overlays only the bottom 32px.
    iframe.style.width = input.collapsed
      ? "100%"
      : `calc(100vw - ${String(input.width)}px)`;
  } else {
    // Host's renderIframe sets inline width:100%. Restore
    // that explicitly. Clearing to "" falls back to the HTML iframe
    // default of 300px and breaks the layout.
    iframe.style.width = "100%";
    const panelHeight = input.collapsed ? 32 : input.height;
    iframe.style.height = `calc(100dvh - ${String(topOffset)}px - ${String(panelHeight)}px)`;
  }
}

export function restoreIframeLayout(): void {
  const iframe = document.querySelector<HTMLIFrameElement>("iframe");
  if (iframe === null) {
    return;
  }
  const hasTopbar = document.getElementById("topbar") !== null;
  iframe.style.height = hasTopbar ? "calc(100dvh - 56px)" : "100dvh";
  iframe.style.width = "100%";
}
