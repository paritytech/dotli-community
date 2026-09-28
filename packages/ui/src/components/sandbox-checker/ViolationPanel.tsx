// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Sandbox Checker panel (dev builds with VITE_SANDBOX_CHECKER).
//
// Listens for DOTLI_API_VIOLATION messages from the product iframe and lists
// them in a collapsible panel at the bottom of the viewport. Violation fields
// come from the product, so they only ever render as text.
//
// A product that trips a guarded API in a loop posts at frame rate, so the
// log keeps only the newest MAX_ENTRIES (the badge still counts them all),
// and each update forces at most one layout.

import { createEffect, createSignal, For, onCleanup, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { setDockInset } from "../../product-frame-layout";

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
/** Entries kept in the log; older ones are dropped. */
const MAX_ENTRIES = 500;

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
  // One array for the panel's lifetime, trimmed in place: copying it on
  // every violation made a looping product O(n²). `equals: false` makes
  // each in-place update notify.
  const entries: Violation[] = [];
  const [violations, setViolations] = createSignal<readonly Violation[]>(
    entries,
    { equals: false },
  );
  const [total, setTotal] = createSignal(0);
  const [collapsed, setCollapsed] = createSignal(false);
  const [height, setHeight] = createSignal<number | null>(null);
  // Read once: the iframe never changes for the panel's lifetime. The read
  // happens here, in the component body, which is where Solid's
  // `STRICT_READ_UNTRACKED` check applies (the `message` listener runs later,
  // outside it), so it goes through `untrack`.
  const iframe = untrack(() => props.iframe);
  let panel: HTMLDivElement | undefined;
  let log: HTMLDivElement | undefined;
  let handle: HTMLDivElement | undefined;
  let nextId = 0;
  let dragging = false;

  // The frame layout keeps the product clear of the panel's height.
  const reserve = (bottom: number): void => {
    setDockInset({ right: 0, bottom }, "sandbox-checker");
  };

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow) {
      return;
    }
    const violation = parseViolation(event.data);
    if (violation === null) {
      return;
    }
    entries.push({
      id: nextId++,
      time: new Date(violation.timestamp).toLocaleTimeString(),
      api: violation.api,
      details: violation.details,
    });
    if (entries.length > MAX_ENTRIES) {
      entries.shift();
    }
    setViolations(entries);
    setTotal((n) => n + 1);
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
    reserve(0);
  });

  // New entry: scroll to it. Visible, collapsed or resized: refit the frame
  // (the log grows until its max-height, so a new entry can move it too).
  // Both measures are read before either write, so one update forces one
  // layout, and an unchanged inset is not reported again.
  let reserved: number | null = null;
  let scrolledAt = 0;
  createEffect(
    () => [total(), collapsed(), height()] as const,
    ([count, isCollapsed]) => {
      if (count === 0) {
        return;
      }
      const bottom = isCollapsed
        ? COLLAPSED_HEIGHT
        : (panel?.offsetHeight ?? 0);
      if (log !== undefined && count !== scrolledAt) {
        scrolledAt = count;
        log.scrollTop = log.scrollHeight;
      }
      if (bottom !== reserved) {
        reserved = bottom;
        reserve(bottom);
      }
    },
  );

  return (
    <div
      id="sandbox-checker-panel"
      class={{ visible: total() > 0, collapsed: collapsed() }}
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
        <span class="sc-badge">{String(total())}</span>
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
