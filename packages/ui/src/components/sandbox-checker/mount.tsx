// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imported dynamically by bridge.ts, only in VITE_SANDBOX_CHECKER builds.

import { mountRoot } from "../../mount/root";
import { ViolationPanel } from "./ViolationPanel";

const ROOT = "sandbox-checker";

/** Show the violation panel for `iframe`. Returns the dispose function. */
export function mountViolationPanel(iframe: HTMLIFrameElement): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const disposeView = mountRoot(ROOT, container, () => (
    <ViolationPanel iframe={iframe} />
  ));
  return () => {
    disposeView();
    container.remove();
    iframe.style.height =
      document.getElementById("topbar") !== null
        ? "calc(100dvh - 56px)"
        : "100dvh";
  };
}
