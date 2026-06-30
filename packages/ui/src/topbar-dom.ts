// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Small DOM helpers shared between the top bar's settings popover and its
// diagnostics panel. Kept in their own module so neither panel has to import
// the other just to reuse them.

export function appendSectionHeader(parent: HTMLElement, text: string): void {
  const header = document.createElement("div");
  header.className = "mode-popover-section";
  header.textContent = text;
  parent.appendChild(header);
}
