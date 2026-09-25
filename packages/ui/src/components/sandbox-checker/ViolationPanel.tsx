// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Sandbox Checker panel (dev builds with VITE_SANDBOX_CHECKER).
//
// Listens for DOTLI_API_VIOLATION messages from the product iframe and lists
// them in a collapsible panel at the bottom of the viewport. Violation fields
// come from the product, so they only ever render as text.

import { createEffect, createSignal, For, onCleanup, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";

interface Violation {
  id: number;
  time: string;
  api: string;
  details: string;
}

const COLLAPSED_HEIGHT = 32;
const HEADER_AND_HANDLE = 32 + 5;
const MIN_HEIGHT = 40;
const MAX_VIEWPORT_SHARE = 0.8;

function parseViolation(
  raw: unknown,
): { api: string; details: string; timestamp: number } | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const data = raw as {
    type?: unknown;
    api?: unknown;
    details?: unknown;
    timestamp?: unknown;
  };
  if (data.type !== "DOTLI_API_VIOLATION") {
    return null;
  }
  const details =
    typeof data.details === "object" && data.details !== null
      ? Object.entries(data.details as Record<string, unknown>)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(" ")
      : "";
  return {
    api: String(data.api),
    details,
    timestamp: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
  };
}

export function ViolationPanel(props: {
  iframe: HTMLIFrameElement;
}): JSX.Element {
  const [violations, setViolations] = createSignal<Violation[]>([]);
  const [collapsed, setCollapsed] = createSignal(false);
  const [height, setHeight] = createSignal<number | null>(null);
  // Read once: the iframe never changes for the panel's lifetime, and both
  // `adjustIframe` and `onMessage` run outside a tracking scope (an effect's
  // untracked callback and a native `message` listener), where reading
  // `props.iframe` directly would trip the `STRICT_READ_UNTRACKED` dev
  // diagnostic.
  const iframe = untrack(() => props.iframe);
  let panel: HTMLDivElement | undefined;
  let log: HTMLDivElement | undefined;
  let handle: HTMLDivElement | undefined;
  let nextId = 0;
  let dragging = false;
  const topbarOffset = document.getElementById("topbar") !== null ? 56 : 0;

  const adjustIframe = (isCollapsed: boolean): void => {
    const panelHeight = isCollapsed
      ? COLLAPSED_HEIGHT
      : (panel?.offsetHeight ?? 0);
    iframe.style.height = `calc(100dvh - ${String(topbarOffset)}px - ${String(panelHeight)}px)`;
  };

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow) {
      return;
    }
    const violation = parseViolation(event.data);
    if (violation === null) {
      return;
    }
    setViolations((list) => [
      ...list,
      {
        id: nextId++,
        time: new Date(violation.timestamp).toLocaleTimeString(),
        api: violation.api,
        details: violation.details,
      },
    ]);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    const viewportHeight = window.innerHeight;
    setHeight(
      Math.max(
        MIN_HEIGHT,
        Math.min(
          viewportHeight - event.clientY,
          viewportHeight * MAX_VIEWPORT_SHARE,
        ),
      ),
    );
  };

  const onPointerUp = (): void => {
    if (!dragging) {
      return;
    }
    dragging = false;
    document.body.style.userSelect = "";
  };

  window.addEventListener("message", onMessage);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  onCleanup(() => {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    if (dragging) {
      dragging = false;
      document.body.style.userSelect = "";
    }
  });

  // New entry: scroll to it. Visible, collapsed or resized: refit the frame.
  createEffect(
    () => violations().length,
    () => {
      if (log !== undefined) {
        log.scrollTop = log.scrollHeight;
      }
    },
  );
  // Refit iframe on every new violation on purpose (the log grows until its max-height).
  createEffect(
    () => [violations().length > 0, collapsed(), height()] as const,
    ([visible, isCollapsed]) => {
      if (visible) {
        adjustIframe(isCollapsed);
      }
    },
  );

  return (
    <div
      id="sandbox-checker-panel"
      class={{ visible: violations().length > 0, collapsed: collapsed() }}
      style={{
        height:
          !collapsed() && height() !== null
            ? `${String(height())}px`
            : undefined,
      }}
      ref={(el) => {
        panel = el;
      }}
    >
      <div
        class="sc-resize-handle"
        ref={(el) => {
          handle = el;
        }}
        onPointerDown={(event) => {
          if (collapsed() || handle === undefined) {
            return;
          }
          dragging = true;
          try {
            handle.setPointerCapture(event.pointerId);
            // eslint-disable-next-line no-restricted-syntax -- happy-dom throws for synthetic pointer ids in tests; capture is best-effort in real browsers too.
          } catch {
            /* synthetic event */
          }
          document.body.style.userSelect = "none";
        }}
      />
      <div class="sc-header">
        <span class="sc-badge">{String(violations().length)}</span>
        <span class="sc-label">API Violations</span>
        <button
          type="button"
          class="sc-toggle"
          aria-label="Toggle panel"
          onClick={() => {
            // Collapsing clears any custom height.
            if (!collapsed()) {
              setHeight(null);
            }
            setCollapsed(!collapsed());
          }}
        >
          {collapsed() ? "▲" : "▼"}
        </button>
      </div>
      <div
        class="sc-log"
        style={{
          "max-height":
            !collapsed() && height() !== null
              ? `${String((height() ?? 0) - HEADER_AND_HANDLE)}px`
              : undefined,
        }}
        ref={(el) => {
          log = el;
        }}
      >
        <For each={violations()}>
          {(entry) => (
            <div class="sc-entry">
              <span class="sc-time">{entry.time}</span>{" "}
              <span class="sc-api">{entry.api}</span>{" "}
              {entry.details !== "" ? (
                <span class="sc-details">{entry.details}</span>
              ) : null}
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
