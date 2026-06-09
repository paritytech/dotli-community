// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Sandbox Checker UI.
//
// Listens for DOTLI_API_VIOLATION messages from the dApp iframe and
// displays them in a collapsible panel at the bottom of the viewport.

interface ViolationMessage {
  type: "DOTLI_API_VIOLATION";
  api: string;
  details: Record<string, unknown>;
  timestamp: number;
}

/**
 * Set up the violation panel that listens for sandbox checker reports
 * from the given iframe. Returns a dispose function to tear down
 * the listener and remove the panel.
 */
export function setupViolationPanel(iframe: HTMLIFrameElement): () => void {
  const panel = document.createElement("div");
  panel.id = "sandbox-checker-panel";
  panel.innerHTML = `
    <div class="sc-resize-handle"></div>
    <div class="sc-header">
      <span class="sc-badge">0</span>
      <span class="sc-label">API Violations</span>
      <button class="sc-toggle" aria-label="Toggle panel">▼</button>
    </div>
    <div class="sc-log"></div>
  `;
  document.body.appendChild(panel);

  /* eslint-disable @typescript-eslint/non-nullable-type-assertion-style */
  const badge = panel.querySelector(".sc-badge") as HTMLSpanElement;
  const log = panel.querySelector(".sc-log") as HTMLDivElement;
  const toggle = panel.querySelector(".sc-toggle") as HTMLButtonElement;
  const resizeHandle = panel.querySelector(
    ".sc-resize-handle",
  ) as HTMLDivElement;
  /* eslint-enable @typescript-eslint/non-nullable-type-assertion-style */
  let count = 0;
  let collapsed = false;

  toggle.addEventListener("click", () => {
    collapsed = !collapsed;
    panel.classList.toggle("collapsed", collapsed);
    toggle.textContent = collapsed ? "▲" : "▼";
    // Clear any custom height when collapsing
    if (collapsed) {
      panel.style.height = "";
      log.style.maxHeight = "";
    }
    adjustIframe();
  });

  // Drag-to-resize.
  let dragging = false;

  function onPointerDown(e: PointerEvent): void {
    if (collapsed) {
      return;
    }
    dragging = true;
    resizeHandle.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging) {
      return;
    }
    const panelTop = e.clientY;
    const viewportHeight = window.innerHeight;
    const newHeight = viewportHeight - panelTop;
    // Clamp between header-only (~40px) and 80% of viewport
    const clamped = Math.max(40, Math.min(newHeight, viewportHeight * 0.8));
    panel.style.height = `${String(clamped)}px`;
    const headerHeight = 32 + 5; // header + resize handle
    log.style.maxHeight = `${String(clamped - headerHeight)}px`;
    adjustIframe();
  }

  function onPointerUp(): void {
    if (!dragging) {
      return;
    }
    dragging = false;
    document.body.style.userSelect = "";
  }

  resizeHandle.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);

  const hasTopbar = document.getElementById("topbar") !== null;
  const topbarOffset = hasTopbar ? 56 : 0;

  function adjustIframe(): void {
    const panelHeight = collapsed ? 32 : panel.offsetHeight;
    iframe.style.height = `calc(100vh - ${String(topbarOffset)}px - ${String(panelHeight)}px)`;
  }

  function onMessage(event: MessageEvent): void {
    if (event.source !== iframe.contentWindow) {
      return;
    }
    const raw: unknown = event.data;
    if (
      typeof raw !== "object" ||
      raw === null ||
      (raw as { type?: unknown }).type !== "DOTLI_API_VIOLATION"
    ) {
      return;
    }
    const data = raw as ViolationMessage;

    count++;
    badge.textContent = String(count);

    const entry = document.createElement("div");
    entry.className = "sc-entry";

    const time = new Date(data.timestamp).toLocaleTimeString();
    const detailParts: string[] = [];
    for (const [k, v] of Object.entries(data.details)) {
      detailParts.push(`${k}=${String(v)}`);
    }

    entry.innerHTML =
      `<span class="sc-time">${time}</span> ` +
      `<span class="sc-api">${escapeHtml(data.api)}</span> ` +
      (detailParts.length
        ? `<span class="sc-details">${escapeHtml(detailParts.join(" "))}</span>`
        : "");

    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;

    // Show panel on first violation
    if (count === 1) {
      panel.classList.add("visible");
      adjustIframe();
    }
  }

  window.addEventListener("message", onMessage);

  return () => {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    panel.remove();
    iframe.style.height = hasTopbar ? "calc(100vh - 56px)" : "100vh";
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
