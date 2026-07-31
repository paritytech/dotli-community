// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// TrUAPI debug panel DOM and interaction.
//
// A docked, resizable panel that lists dotli-internal debug events. Intended
// for host-side debugging only; gated behind a feature flag in `apps/host`.
//
// All DOM is created lazily on `setupTruapiDebugPanel()` and torn down
// by the returned dispose function. Stylesheet is injected once per
// document, keyed by id.

import { escapeHtml } from "@dotli/shared/html";
import {
  decodeChainAnnotations,
  formatChainLabel,
  type ChainAnnotations,
} from "./chain-decode.ts";
import { summariseChainMessage } from "./chain-summary.ts";
import { getSystemExplanation } from "./system-explanations.ts";
import { summariseSystemEvent } from "./system-summary.ts";
import { onDotliDebugEvent } from "./dotli-debug-bus.ts";
import {
  correlationKeyOf,
  type EventSeq,
  type StoredEvent,
  type StoredSystemEvent,
  type StoredTruapiEvent,
} from "./event-store.ts";
import { EventStore } from "./event-store.ts";
import type { DotliDebugBusEvent } from "./dotli-debug-bus.ts";
import { buildExport, exportFilename, type ExportMeta } from "./export.ts";
import {
  initialFilterState,
  matches,
  type DirectionFilter,
  type FilterState,
} from "./filters.ts";
import { formatPayloadDetail, formatPayloadSummary } from "./format.ts";
import {
  applyTimelineSelection,
  buildTimelineContainer,
  renderSwimlanes,
  resolveTimelineClick,
} from "./timeline.ts";

const DEFAULT_CAPACITY = 2000;
const STYLE_ID = "truapi-debug-styles";
const PANEL_ID = "truapi-debug-panel";
const DOCK_STORAGE_KEY = "truapi-debug:dock";
const DEBUG_SESSION_KEY = "dotli:truapi-debug";

type DockPosition = "bottom" | "right";

function isTruapiDebugEvent(
  ev: DotliDebugBusEvent,
): ev is Extract<DotliDebugBusEvent, { kind: "truapi" }> {
  return "kind" in ev;
}

function readStoredDock(): DockPosition {
  try {
    const raw = localStorage.getItem(DOCK_STORAGE_KEY);
    if (raw === "right") {
      return "right";
    }
    // eslint-disable-next-line no-restricted-syntax -- localStorage may throw in Safari private mode; default to bottom dock.
  } catch {
    /* swallow */
  }
  return "bottom";
}

function writeStoredDock(dock: DockPosition): void {
  try {
    localStorage.setItem(DOCK_STORAGE_KEY, dock);
    // eslint-disable-next-line no-restricted-syntax -- localStorage may throw on quota/private mode; persistence is best-effort.
  } catch {
    /* swallow */
  }
}

export interface SetupOptions {
  /** Hard cap on retained events before oldest are evicted. */
  capacity?: number;
  /**
   * Mount the panel collapsed (header-only). Used when debug mode is
   * auto-enabled in dev environments so the panel doesn't cover content
   * unsolicited; explicit opt-ins (Settings button / `?debug=true`)
   * mount expanded.
   */
  startCollapsed?: boolean;
}

/**
 * Install the TrUAPI debug panel into the current document.
 *
 * Creates a single panel bound to the current page, subscribes once to
 * the dotli debug bus, and returns a dispose function that tears everything
 * down (DOM + subscription).
 *
 * The panel mounts visible whenever debug mode is on. The header's `×`
 * button exits debug mode entirely (clears the session flag and
 * reloads). Re-enter via the host Settings panel's "Open in debug
 * mode" button.
 *
 * Calling twice without disposing is a no-op on the second call.
 */
export function setupTruapiDebugPanel(options: SetupOptions = {}): () => void {
  if (document.getElementById(PANEL_ID) !== null) {
    return () => {
      /* already mounted; owner should dispose the original handle */
    };
  }

  injectStyles();

  const store = new EventStore({
    capacity: options.capacity ?? DEFAULT_CAPACITY,
  });
  const state: PanelState = {
    collapsed: options.startCollapsed ?? false,
    expandedHeight: "",
    selectedSeq: null,
    filters: initialFilterState(),
    view: "list",
    dock: readStoredDock(),
  };

  const ui = buildPanel(state, store);
  document.body.appendChild(ui.panel);
  applyDockPosition(ui, state, { persist: false });
  if (state.collapsed) {
    ui.panel.classList.add("collapsed");
    ui.collapseBtn.textContent = "▲";
  }

  // When a new product iframe is mounted, re-apply the iframe height
  // adjustment so the panel doesn't cover freshly-rendered app content.
  const onProductLoaded = (): void => {
    adjustIframeForPanel(ui.panel, state);
  };
  window.addEventListener("dotli:product-loaded", onProductLoaded);

  ui.closeBtn.addEventListener("click", () => {
    // Exit debug mode entirely: the panel is bound to debug mode, and
    // re-entry is via the host Settings "Open in debug mode" button.
    try {
      sessionStorage.setItem(DEBUG_SESSION_KEY, "0");
      // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in exotic environments; fall through to plain reload.
    } catch {
      /* ignore */
    }
    window.location.reload();
  });

  // Event subscription. rAF-throttled render to avoid jank under load.
  let renderScheduled = false;
  const scheduleRender = (): void => {
    if (renderScheduled) {
      return;
    }
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      render(ui, state, store);
    });
  };

  const unsubscribeStore = store.subscribe(scheduleRender);
  const unsubscribeDotli = onDotliDebugEvent((ev) => {
    if (isTruapiDebugEvent(ev)) {
      store.insertTruapi(ev);
    } else {
      store.insertDotli(ev);
    }
  });

  // Initial render + iframe adjustment.
  render(ui, state, store, { fullList: true });
  adjustIframeForPanel(ui.panel, state);

  return () => {
    unsubscribeDotli();
    unsubscribeStore();
    window.removeEventListener("dotli:product-loaded", onProductLoaded);
    ui.panel.remove();
    restoreIframeLayout();
  };
}

/** Adjust the currently-mounted product iframe so the panel doesn't overlay it. */
function adjustIframeForPanel(panel: HTMLElement, state: PanelState): void {
  const iframe = document.querySelector<HTMLIFrameElement>("iframe");
  if (iframe === null) {
    return;
  }
  const hasTopbar = document.getElementById("topbar") !== null;
  const topOffset = hasTopbar ? 56 : 0;
  if (state.dock === "right") {
    iframe.style.height = `calc(100vh - ${String(topOffset)}px)`;
    // When collapsed, the 32px header bar overlays the top-right corner
    // of the iframe rather than reserving a full-height column. Mirrors
    // how bottom-dock collapse overlays only the bottom 32px.
    iframe.style.width = state.collapsed
      ? "100%"
      : `calc(100vw - ${String(panel.offsetWidth)}px)`;
  } else {
    // Host's renderIframe sets inline width:100%. Restore
    // that explicitly. Clearing to "" falls back to the HTML iframe
    // default of 300px and breaks the layout.
    iframe.style.width = "100%";
    const panelHeight = state.collapsed ? 32 : panel.offsetHeight;
    iframe.style.height = `calc(100vh - ${String(topOffset)}px - ${String(panelHeight)}px)`;
  }
}

function restoreIframeLayout(): void {
  const iframe = document.querySelector<HTMLIFrameElement>("iframe");
  if (iframe === null) {
    return;
  }
  const hasTopbar = document.getElementById("topbar") !== null;
  iframe.style.height = hasTopbar ? "calc(100vh - 40px)" : "100vh";
  iframe.style.width = "100%";
}

type PanelView = "list" | "timeline";

interface PanelState {
  collapsed: boolean;
  /** Inline drag-resize height stashed while collapsed, restored on expand. */
  expandedHeight: string;
  selectedSeq: EventSeq | null;
  filters: FilterState;
  view: PanelView;
  dock: DockPosition;
}

interface PanelUI {
  panel: HTMLDivElement;
  resizeHandle: HTMLDivElement;
  counts: HTMLSpanElement;
  pauseBtn: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
  exportBtn: HTMLButtonElement;
  copyBtn: HTMLButtonElement;
  dockBtn: HTMLButtonElement;
  collapseBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
  dirChips: Record<DirectionFilter, HTMLButtonElement>;
  productChipsContainer: HTMLDivElement;
  tagInput: HTMLInputElement;
  tabs: Record<PanelView, HTMLButtonElement>;
  list: HTMLDivElement;
  timeline: HTMLDivElement;
  detail: HTMLDivElement;
  bodySplitter: HTMLDivElement;
  tooltip: HTMLDivElement;
}

function buildPanel(state: PanelState, store: EventStore): PanelUI {
  const panel = document.createElement("div");
  panel.id = PANEL_ID;

  panel.innerHTML = `
    <div class="td-resize-handle" role="separator" aria-orientation="horizontal"></div>
    <div class="td-header">
      <span class="td-title">TrUAPI Debug</span>
      <span class="td-counts">0 events</span>
      <span class="td-spacer"></span>
      <button class="td-btn td-pause" type="button">Pause</button>
      <button class="td-btn td-clear" type="button">Clear</button>
      <button class="td-btn td-btn-icon td-export" type="button" title="Download as JSON" aria-label="Download as JSON">${EXPORT_ICON_SVG}</button>
      <button class="td-btn td-btn-icon td-copy" type="button" title="Copy to clipboard" aria-label="Copy to clipboard">${COPY_ICON_SVG}</button>
      <button class="td-btn td-btn-icon td-dock" type="button" title="Dock to right" aria-label="Dock to right"></button>
      <button class="td-btn td-btn-icon td-collapse" type="button" title="Collapse">▼</button>
      <button class="td-close" type="button" title="Hide (Ctrl+Shift+D)">×</button>
    </div>
    <div class="td-filters">
      <div class="td-filter-group td-kind-group">
        <span class="td-filter-label">show</span>
        <label class="td-kind-check"><input type="checkbox" class="td-kind" data-kind="truapi" checked /> TrUAPI</label>
        <label class="td-kind-check"><input type="checkbox" class="td-kind" data-kind="system" checked /> System</label>
      </div>
      <div class="td-filter-group td-dir-group">
        <span class="td-filter-label">dir</span>
        <button class="td-chip td-dir" data-dir="both">both</button>
        <button class="td-chip td-dir" data-dir="outgoing">▶ out</button>
        <button class="td-chip td-dir" data-dir="incoming">◀ in</button>
      </div>
      <div class="td-filter-group">
        <span class="td-filter-label">product</span>
        <div class="td-product-chips"></div>
      </div>
      <div class="td-filter-group">
        <span class="td-filter-label">tag</span>
        <input class="td-input td-tag-input" type="search" placeholder="filter by method…" spellcheck="false" autocomplete="off" />
      </div>
    </div>
    <div class="td-body">
      <div class="td-views">
        <div class="td-tabs" role="tablist">
          <button class="td-tab active" role="tab" data-view="list" type="button">List</button>
          <button class="td-tab" role="tab" data-view="timeline" type="button">Timeline</button>
        </div>
        <div class="td-list" role="list" tabindex="0"></div>
        <!-- timeline mount point — populated at setup time -->
      </div>
      <div class="td-body-splitter" role="separator" aria-orientation="vertical" tabindex="-1" title="Drag to resize"></div>
      <div class="td-detail"></div>
    </div>
    <div class="td-tooltip" aria-hidden="true"></div>
  `;

  /* eslint-disable @typescript-eslint/non-nullable-type-assertion-style */
  const views = panel.querySelector(".td-views") as HTMLDivElement;
  const { container: timeline } = buildTimelineContainer();
  timeline.classList.add("hidden");
  views.appendChild(timeline);

  const ui: PanelUI = {
    panel,
    resizeHandle: panel.querySelector(".td-resize-handle") as HTMLDivElement,
    counts: panel.querySelector(".td-counts") as HTMLSpanElement,
    pauseBtn: panel.querySelector(".td-pause") as HTMLButtonElement,
    clearBtn: panel.querySelector(".td-clear") as HTMLButtonElement,
    exportBtn: panel.querySelector(".td-export") as HTMLButtonElement,
    copyBtn: panel.querySelector(".td-copy") as HTMLButtonElement,
    dockBtn: panel.querySelector(".td-dock") as HTMLButtonElement,
    collapseBtn: panel.querySelector(".td-collapse") as HTMLButtonElement,
    closeBtn: panel.querySelector(".td-close") as HTMLButtonElement,
    dirChips: {
      both: panel.querySelector(
        '.td-dir[data-dir="both"]',
      ) as HTMLButtonElement,
      outgoing: panel.querySelector(
        '.td-dir[data-dir="outgoing"]',
      ) as HTMLButtonElement,
      incoming: panel.querySelector(
        '.td-dir[data-dir="incoming"]',
      ) as HTMLButtonElement,
    },
    productChipsContainer: panel.querySelector(
      ".td-product-chips",
    ) as HTMLDivElement,
    tagInput: panel.querySelector(".td-tag-input") as HTMLInputElement,
    tabs: {
      list: panel.querySelector(
        '.td-tab[data-view="list"]',
      ) as HTMLButtonElement,
      timeline: panel.querySelector(
        '.td-tab[data-view="timeline"]',
      ) as HTMLButtonElement,
    },
    list: panel.querySelector(".td-list") as HTMLDivElement,
    timeline,
    detail: panel.querySelector(".td-detail") as HTMLDivElement,
    bodySplitter: panel.querySelector(".td-body-splitter") as HTMLDivElement,
    tooltip: panel.querySelector(".td-tooltip") as HTMLDivElement,
  };
  /* eslint-enable @typescript-eslint/non-nullable-type-assertion-style */

  wireHeader(ui, state, store);
  wireFilters(ui, state, store);
  wireResize(ui, state);
  wireListSelection(ui, state, store);
  wireTabs(ui, state, store);
  wireTimelineSelection(ui, state, store);
  wireTimelineTooltip(ui);
  wireBodySplitter(ui, state);

  return ui;
}

const COPY_FLASH_MS = 1200;

// Lucide glyphs, inlined like the dock icons below.
const EXPORT_ICON_SVG = `
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 15V3"/>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <path d="m7 10 5 5 5-5"/>
  </svg>
`;
const COPY_ICON_SVG = `
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
  </svg>
`;

/** Exports carry the filtered view — what the user currently sees. */
function buildFilteredExportJson(state: PanelState, store: EventStore): string {
  const all = store.list();
  const events = all.filter((e) => matches(e, state.filters));
  const meta: ExportMeta = {
    exportedAt: new Date().toISOString(),
    url: window.location.href,
    userAgent: navigator.userAgent,
    capacity: store.capacity,
    droppedCount: store.dropped(),
    totalEvents: all.length,
    exportedEvents: events.length,
    filters: state.filters,
  };
  return buildExport(events, meta);
}

/** Swap a button's content for a moment, disabled while it shows.
 *  Callers that flash after awaiting a promise must disable the button
 *  synchronously at click time, or a rapid second click could capture
 *  the flashed content as the "original" to restore. */
function flashButton(btn: HTMLButtonElement, html: string): void {
  const original = btn.innerHTML;
  btn.innerHTML = html;
  btn.disabled = true;
  window.setTimeout(() => {
    btn.innerHTML = original;
    btn.disabled = false;
  }, COPY_FLASH_MS);
}

function wireHeader(ui: PanelUI, state: PanelState, store: EventStore): void {
  ui.pauseBtn.addEventListener("click", () => {
    const paused = !store.isPaused();
    store.setPaused(paused);
    ui.pauseBtn.textContent = paused ? "Resume" : "Pause";
    ui.pauseBtn.classList.toggle("active", paused);
  });
  ui.clearBtn.addEventListener("click", () => {
    store.clear();
    state.selectedSeq = null;
    // Explicitly rebuild detail: the selection is now gone and the
    // incremental-render path intentionally doesn't touch the detail
    // pane, so without this the previously-selected event's body
    // would linger after clear.
    renderDetail(ui, state, store);
  });
  ui.exportBtn.addEventListener("click", () => {
    const json = buildFilteredExportJson(state, store);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFilename(new Date());
    // Attach before clicking and revoke on the next tick — Safari can
    // silently abort the download otherwise.
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  });
  ui.copyBtn.addEventListener("click", () => {
    // Disabled synchronously: see flashButton's doc comment.
    ui.copyBtn.disabled = true;
    // Typed as always present, but absent on non-secure origins
    // (Clipboard API is [SecureContext]-only).
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) {
      flashButton(ui.copyBtn, "✕");
      return;
    }
    const json = buildFilteredExportJson(state, store);
    clipboard.writeText(json).then(
      () => {
        flashButton(ui.copyBtn, "✓");
      },
      () => {
        flashButton(ui.copyBtn, "✕");
      },
    );
  });
  ui.collapseBtn.addEventListener("click", () => {
    state.collapsed = !state.collapsed;
    if (state.collapsed) {
      // An inline drag-resize height would override the collapsed 32px
      // rule and leave an empty panel-sized box. Stash it while collapsed
      // and restore it on expand.
      state.expandedHeight = ui.panel.style.height;
      ui.panel.style.height = "";
    } else if (state.expandedHeight !== "") {
      ui.panel.style.height = state.expandedHeight;
    }
    ui.panel.classList.toggle("collapsed", state.collapsed);
    ui.collapseBtn.textContent = state.collapsed ? "▲" : "▼";
    adjustIframeForPanel(ui.panel, state);
  });
  ui.dockBtn.addEventListener("click", () => {
    state.dock = state.dock === "bottom" ? "right" : "bottom";
    applyDockPosition(ui, state, { persist: true });
  });
  // The × close button is wired up in setupTruapiDebugPanel so it can
  // toggle the topbar button's active state alongside panel visibility.
}

/**
 * Sync the panel DOM with `state.dock`: toggle the `docked-right` class,
 * clear inline resize overrides and split-size custom properties (each
 * orientation starts from its CSS default), refresh the dock button's
 * icon/title, and re-fit the host iframe.
 */
const DOCK_RIGHT_SVG = `
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1"/>
    <line x1="10" y1="2.5" x2="10" y2="13.5"/>
    <rect x="10" y="2.5" width="4.5" height="11" fill="currentColor" fill-opacity="0.4" stroke="none"/>
  </svg>
`;
const DOCK_BOTTOM_SVG = `
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1"/>
    <line x1="1.5" y1="10" x2="14.5" y2="10"/>
    <rect x="1.5" y="10" width="13" height="3.5" fill="currentColor" fill-opacity="0.4" stroke="none"/>
  </svg>
`;

function applyDockPosition(
  ui: PanelUI,
  state: PanelState,
  opts: { persist: boolean },
): void {
  ui.panel.classList.toggle("docked-right", state.dock === "right");
  ui.panel.style.height = "";
  ui.panel.style.width = "";
  // The stashed pre-collapse height belongs to the previous orientation.
  state.expandedHeight = "";
  ui.panel.style.removeProperty("--td-left-width");
  ui.panel.style.removeProperty("--td-top-height");
  // Right-dock sits below the host topbar (40px) so the dock toggle and
  // session controls remain reachable. Bottom-dock clears the override
  // since it pins to the viewport bottom edge.
  if (state.dock === "right") {
    const hasTopbar = document.getElementById("topbar") !== null;
    ui.panel.style.top = hasTopbar ? "40px" : "0";
  } else {
    ui.panel.style.top = "";
  }
  if (state.dock === "right") {
    ui.dockBtn.innerHTML = DOCK_BOTTOM_SVG;
    ui.dockBtn.title = "Dock to bottom";
    ui.dockBtn.setAttribute("aria-label", "Dock to bottom");
  } else {
    ui.dockBtn.innerHTML = DOCK_RIGHT_SVG;
    ui.dockBtn.title = "Dock to right";
    ui.dockBtn.setAttribute("aria-label", "Dock to right");
  }
  if (opts.persist) {
    writeStoredDock(state.dock);
  }
  adjustIframeForPanel(ui.panel, state);
}

function wireFilters(ui: PanelUI, state: PanelState, store: EventStore): void {
  for (const [dir, btn] of Object.entries(ui.dirChips) as [
    DirectionFilter,
    HTMLButtonElement,
  ][]) {
    btn.addEventListener("click", () => {
      state.filters.direction = dir;
      render(ui, state, store, { fullList: true });
    });
  }
  ui.tagInput.addEventListener("input", () => {
    state.filters.tagQuery = ui.tagInput.value;
    render(ui, state, store, { fullList: true });
  });
  for (const cb of Array.from(
    ui.panel.querySelectorAll<HTMLInputElement>(".td-kind"),
  )) {
    cb.addEventListener("change", () => {
      const kind = cb.dataset.kind;
      if (kind === "truapi") {
        state.filters.showTruapi = cb.checked;
      } else if (kind === "system") {
        state.filters.showSystem = cb.checked;
      }
      render(ui, state, store, { fullList: true });
    });
  }
}

function wireResize(ui: PanelUI, state: PanelState): void {
  let dragging = false;
  const onPointerDown = (e: PointerEvent): void => {
    if (state.collapsed) {
      return;
    }
    dragging = true;
    ui.resizeHandle.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    if (state.dock === "right") {
      const newWidth = window.innerWidth - e.clientX;
      const clamped = Math.max(
        280,
        Math.min(newWidth, window.innerWidth * 0.8),
      );
      ui.panel.style.width = `${String(clamped)}px`;
    } else {
      const newHeight = window.innerHeight - e.clientY;
      const clamped = Math.max(
        120,
        Math.min(newHeight, window.innerHeight * 0.8),
      );
      ui.panel.style.height = `${String(clamped)}px`;
    }
    adjustIframeForPanel(ui.panel, state);
  };
  const onPointerUp = (): void => {
    if (!dragging) {
      return;
    }
    dragging = false;
    document.body.style.userSelect = "";
  };
  ui.resizeHandle.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
}

/**
 * Drag-to-resize divider between the views pane (list / timeline) and
 * the event-detail pane. Left-pane width persists in a CSS custom
 * property on the panel element so the grid picks it up without a
 * JS render cycle. Clamped to keep either side from collapsing so far
 * that its controls become unusable.
 */
const MIN_PRIMARY_PX = 220; // events list / top pane: filter chips + tabs need room
const MIN_SECONDARY_PX = 260; // detail / bottom pane: room for key-value list
const SPLITTER_PX = 6; // matches the grid-template-{columns,rows} middle track

function wireBodySplitter(ui: PanelUI, state: PanelState): void {
  let dragging = false;
  const onPointerDown = (e: PointerEvent): void => {
    dragging = true;
    ui.bodySplitter.setPointerCapture(e.pointerId);
    ui.bodySplitter.classList.add("dragging");
    document.body.style.userSelect = "none";
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    const bodyRect = ui.bodySplitter.parentElement?.getBoundingClientRect();
    if (bodyRect === undefined) {
      return;
    }
    if (state.dock === "right") {
      const relY = e.clientY - bodyRect.top;
      const maxTop = Math.max(
        MIN_PRIMARY_PX,
        bodyRect.height - MIN_SECONDARY_PX - SPLITTER_PX,
      );
      const clamped = Math.max(MIN_PRIMARY_PX, Math.min(relY, maxTop));
      ui.panel.style.setProperty("--td-top-height", `${String(clamped)}px`);
    } else {
      const relX = e.clientX - bodyRect.left;
      const maxLeft = Math.max(
        MIN_PRIMARY_PX,
        bodyRect.width - MIN_SECONDARY_PX - SPLITTER_PX,
      );
      const clamped = Math.max(MIN_PRIMARY_PX, Math.min(relX, maxLeft));
      ui.panel.style.setProperty("--td-left-width", `${String(clamped)}px`);
    }
  };
  const onPointerUp = (): void => {
    if (!dragging) {
      return;
    }
    dragging = false;
    ui.bodySplitter.classList.remove("dragging");
    document.body.style.userSelect = "";
  };
  ui.bodySplitter.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  // Double-click restores the default proportion. Quick escape hatch if
  // the user drags into a corner.
  ui.bodySplitter.addEventListener("dblclick", () => {
    ui.panel.style.removeProperty("--td-left-width");
    ui.panel.style.removeProperty("--td-top-height");
  });
}

function wireListSelection(
  ui: PanelUI,
  state: PanelState,
  store: EventStore,
): void {
  ui.list.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>(".td-row");
    if (row === null) {
      return;
    }
    const seqAttr = row.dataset.seq;
    if (seqAttr === undefined) {
      return;
    }
    // Move focus to the list so keyboard navigation picks up immediately
    // after a click. Without this, arrow keys would scroll the page
    // instead of stepping through rows.
    ui.list.focus({ preventScroll: true });
    const prev = state.selectedSeq;
    state.selectedSeq = Number(seqAttr);
    applySelection(ui, state, store, prev);
  });

  ui.detail.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const pairLink = target.closest<HTMLElement>(".td-detail-pair");
    if (pairLink === null) {
      return;
    }
    const seqAttr = pairLink.dataset.seq;
    if (seqAttr === undefined) {
      return;
    }
    const prev = state.selectedSeq;
    state.selectedSeq = Number(seqAttr);
    applySelection(ui, state, store, prev);
    // Scroll the paired row into view.
    const row = ui.list.querySelector<HTMLElement>(
      `.td-row[data-seq="${String(state.selectedSeq)}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  });

  // Arrow-key navigation. Only active when the list itself has focus
  // (tabindex=0 on the container), so it doesn't intercept typing in
  // the filter input or global browser shortcuts.
  ui.list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") {
      return;
    }
    const rows = ui.list.querySelectorAll<HTMLElement>(".td-row");
    if (rows.length === 0) {
      return;
    }
    e.preventDefault();
    const seqs = Array.from(rows, (r) => Number(r.dataset.seq));
    const currentIdx =
      state.selectedSeq === null ? -1 : seqs.indexOf(state.selectedSeq);
    let nextIdx: number;
    if (e.key === "ArrowDown") {
      // From nothing, select the first row. From a valid index, the next row (clamped to last).
      nextIdx = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, seqs.length - 1);
    } else {
      // ArrowUp: from nothing, select the last row. Otherwise the previous row (clamped to first).
      nextIdx = currentIdx < 0 ? seqs.length - 1 : Math.max(currentIdx - 1, 0);
    }
    if (nextIdx === currentIdx) {
      return;
    }
    const prev = state.selectedSeq;
    state.selectedSeq = seqs[nextIdx];
    applySelection(ui, state, store, prev);
    rows[nextIdx].scrollIntoView({ block: "nearest" });
  });
}

function wireTabs(ui: PanelUI, state: PanelState, store: EventStore): void {
  for (const [view, btn] of Object.entries(ui.tabs) as [
    PanelView,
    HTMLButtonElement,
  ][]) {
    btn.addEventListener("click", () => {
      if (state.view === view) {
        return;
      }
      state.view = view;
      ui.tabs.list.classList.toggle("active", view === "list");
      ui.tabs.timeline.classList.toggle("active", view === "timeline");
      ui.list.classList.toggle("hidden", view !== "list");
      ui.timeline.classList.toggle("hidden", view !== "timeline");
      render(ui, state, store, { fullList: true });
    });
  }
}

/**
 * Zero-delay hover tooltip for timeline elements. Any SVG element
 * carrying a `data-tooltip` attribute triggers the tooltip on
 * pointerover; `pointermove` updates the position, `pointerleave`
 * hides it. Bypasses the browser's native `<title>` delay so the
 * information appears the instant the cursor lands on a box.
 */
function wireTimelineTooltip(ui: PanelUI): void {
  const showAt = (text: string, clientX: number, clientY: number): void => {
    ui.tooltip.textContent = text;
    ui.tooltip.classList.add("visible");
    // Position (viewport-fixed): offset 12px below-right of the cursor,
    // then clamp to the viewport so the tooltip never gets cropped.
    const panelRect = ui.panel.getBoundingClientRect();
    const left = clientX - panelRect.left + 12;
    const top = clientY - panelRect.top + 16;
    ui.tooltip.style.left = `${String(left)}px`;
    ui.tooltip.style.top = `${String(top)}px`;
    // Clamp right edge.
    const ttRect = ui.tooltip.getBoundingClientRect();
    const panelRight = panelRect.right;
    if (ttRect.right > panelRight - 4) {
      const adjusted = left - (ttRect.right - panelRight) - 6;
      ui.tooltip.style.left = `${String(Math.max(4, adjusted))}px`;
    }
  };
  const hide = (): void => {
    ui.tooltip.classList.remove("visible");
  };
  ui.timeline.addEventListener("pointerover", (e) => {
    const target = e.target as Element | null;
    const el = target?.closest("[data-tooltip]");
    if (el === null || el === undefined) {
      return;
    }
    const text = el.getAttribute("data-tooltip");
    if (text === null) {
      return;
    }
    showAt(text, e.clientX, e.clientY);
  });
  ui.timeline.addEventListener("pointermove", (e) => {
    if (!ui.tooltip.classList.contains("visible")) {
      return;
    }
    const target = e.target as Element | null;
    const el = target?.closest("[data-tooltip]");
    if (el === null || el === undefined) {
      hide();
      return;
    }
    const text = el.getAttribute("data-tooltip");
    if (text === null) {
      hide();
      return;
    }
    showAt(text, e.clientX, e.clientY);
  });
  ui.timeline.addEventListener("pointerleave", hide);
}

function wireTimelineSelection(
  ui: PanelUI,
  state: PanelState,
  store: EventStore,
): void {
  ui.timeline.addEventListener("click", (e) => {
    const seq = resolveTimelineClick(e.target);
    if (seq === null) {
      return;
    }
    ui.timeline.focus({ preventScroll: true });
    const prev = state.selectedSeq;
    state.selectedSeq = seq;
    applyTimelineSelection(ui.timeline, prev, seq);
    // Detail pane is the "ground truth" for selection; rebuild it.
    renderDetail(ui, state, store);
  });
}

/**
 * Update only the selection-related DOM for a user click: toggle the
 * `.selected` / `.paired` classes on rows in the same requestId group
 * as the clicked row, and rebuild the detail pane. Avoids the
 * full-list `innerHTML` rebuild in `render()`, which dropped clicks
 * under heavy traffic (target row replaced between pointerdown and
 * click) and caused hundreds of ms of layout churn on large buffers.
 *
 * `data-rid` on each row lets one `querySelectorAll` collect every
 * sibling in the group. Request/response (two events) and
 * subscriptions (one start, N receives, and a stop) are both handled the
 * same way.
 */
function applySelection(
  ui: PanelUI,
  state: PanelState,
  store: EventStore,
  prevSeq: EventSeq | null,
): void {
  if (prevSeq !== null) {
    const prevEvent = store.getBySeq(prevSeq);
    if (prevEvent !== undefined) {
      clearGroupClasses(ui, correlationKeyOf(prevEvent));
    }
  }

  const newSeq = state.selectedSeq;
  if (newSeq !== null) {
    const newEvent = store.getBySeq(newSeq);
    if (newEvent !== undefined) {
      applyGroupClasses(ui, correlationKeyOf(newEvent), newSeq);
    }
  }

  renderDetail(ui, state, store);
}

function applyGroupClasses(
  ui: PanelUI,
  requestId: string,
  selectedSeq: EventSeq,
): void {
  const rows = ui.list.querySelectorAll<HTMLElement>(
    `.td-row[data-rid="${cssEscape(requestId)}"]`,
  );
  for (const row of Array.from(rows)) {
    const seq = Number(row.dataset.seq);
    row.classList.toggle("selected", seq === selectedSeq);
    row.classList.toggle("paired", seq !== selectedSeq);
  }
}

function clearGroupClasses(ui: PanelUI, requestId: string): void {
  const rows = ui.list.querySelectorAll<HTMLElement>(
    `.td-row[data-rid="${cssEscape(requestId)}"]`,
  );
  for (const row of Array.from(rows)) {
    row.classList.remove("selected", "paired");
  }
}

function cssEscape(value: string): string {
  // nanoid default alphabet (A-Za-z0-9_-) is already CSS-attr-safe, but
  // defend against future id-scheme changes by using the built-in.
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

// Rendering

interface RenderOptions {
  /**
   * When true, tear down and rebuild every row in the event list.
   * Required on filter changes (existing row visibility flips) and
   * initial mount. When false, existing row DOM is preserved and only
   * new rows are appended while evicted rows are pruned. This is critical
   * so that in-flight clicks on rows aren't dropped by `innerHTML =`
   * replacing the target element between pointerdown and click.
   */
  fullList?: boolean;
}

function render(
  ui: PanelUI,
  state: PanelState,
  store: EventStore,
  opts: RenderOptions = {},
): void {
  const all = store.list();
  const visible = all.filter((e) => matches(e, state.filters));

  const dropped = store.dropped();
  const totalLabel =
    dropped > 0
      ? `${String(all.length)} events (+${String(dropped)} dropped)`
      : `${String(all.length)} events`;
  const filterNote =
    visible.length !== all.length ? ` · ${String(visible.length)} shown` : "";
  ui.counts.textContent = `${totalLabel}${filterNote}`;

  renderDirectionChips(ui, state);
  renderProductChips(ui, state, store);
  if (state.view === "list") {
    renderList(ui, state, store, visible, opts.fullList ?? false);
  } else {
    // The timeline is cheap enough to always full-rebuild for now;
    // a future phase can switch to incremental geometry updates if
    // needed. Re-rendered on every new event (rAF-throttled) so
    // pending segments grow toward "now" naturally.
    renderSwimlanes(ui.timeline, visible, state.selectedSeq);
  }
  // Only rebuild the detail pane on user-initiated refreshes (filter
  // change, view swap, clear, initial mount). Rebuilding on every
  // incoming event tears down any in-progress user interaction inside
  // the pane: clicks on the collapsible "What is this?" block get
  // dropped between pointerdown and click when traffic is bursty.
  // Selection changes go through `applySelection` which rebuilds
  // detail explicitly on its own fast path.
  if (opts.fullList === true) {
    renderDetail(ui, state, store);
  }
}

function renderDirectionChips(ui: PanelUI, state: PanelState): void {
  for (const dir of ["both", "outgoing", "incoming"] as DirectionFilter[]) {
    ui.dirChips[dir].classList.toggle(
      "active",
      state.filters.direction === dir,
    );
  }
}

function renderProductChips(
  ui: PanelUI,
  state: PanelState,
  store: EventStore,
): void {
  const products = store.productIds();
  // Sort: string productIds alphabetically, then `undefined` last.
  products.sort((a, b) => {
    if (a === undefined) {
      return 1;
    }
    if (b === undefined) {
      return -1;
    }
    return a.localeCompare(b);
  });

  // Fingerprint of the current product set. If it hasn't changed since
  // the last render we only need to refresh `.active` classes, not
  // tear down and rebuild the buttons. Rebuilding on every event was
  // dropping in-flight clicks on the chips.
  const fingerprint = products.map((p) => p ?? "\0").join("|");
  const prevFingerprint = ui.productChipsContainer.dataset.fingerprint;

  if (prevFingerprint !== fingerprint) {
    const html = [
      `<button class="td-chip td-product-chip" data-product="__all">all</button>`,
    ];
    for (const p of products) {
      const key = p ?? "__anon";
      const label = p ?? "(no id)";
      html.push(
        `<button class="td-chip td-product-chip" data-product="${escapeHtml(key)}">${escapeHtml(label)}</button>`,
      );
    }
    ui.productChipsContainer.innerHTML = html.join("");
    ui.productChipsContainer.dataset.fingerprint = fingerprint;

    // One delegated listener on the container. It survives chip rebuilds,
    // so there's no per-chip listener re-attachment on each render.
    if (ui.productChipsContainer.dataset.wired !== "1") {
      ui.productChipsContainer.dataset.wired = "1";
      ui.productChipsContainer.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
          ".td-product-chip",
        );
        if (btn === null) {
          return;
        }
        const key = btn.dataset.product;
        if (key === "__all") {
          state.filters.product = undefined;
        } else if (key === "__anon") {
          state.filters.product = null;
        } else if (key !== undefined) {
          state.filters.product = key;
        }
        // Filter change alters list contents, so a full rebuild is needed.
        render(ui, state, store, { fullList: true });
      });
    }
  }

  // Refresh `.active` tint on whatever chips are currently there.
  for (const btn of Array.from(
    ui.productChipsContainer.querySelectorAll<HTMLButtonElement>(
      ".td-product-chip",
    ),
  )) {
    const key = btn.dataset.product ?? "";
    const active =
      (key === "__all" && state.filters.product === undefined) ||
      (key === "__anon" && state.filters.product === null) ||
      (key !== "__all" && key !== "__anon" && state.filters.product === key);
    btn.classList.toggle("active", active);
  }
}

/**
 * Fingerprint of the current filter state. If it matches the one the
 * list was last rendered under, new events can be appended in-place
 * (incremental path). If it differs, existing rows may need to change
 * visibility and a full rebuild is required.
 */
function filterFingerprint(state: PanelState): string {
  const product =
    state.filters.product === null
      ? "__null"
      : (state.filters.product ?? "__undef");
  return `${state.filters.direction}|${product}|${state.filters.tagQuery.trim().toLowerCase()}`;
}

function renderList(
  ui: PanelUI,
  state: PanelState,
  store: EventStore,
  visible: readonly StoredEvent[],
  fullRebuild: boolean,
): void {
  const currentFingerprint = filterFingerprint(state);
  const prevFingerprint = ui.list.dataset.fingerprint;
  const canAppendOnly =
    !fullRebuild &&
    prevFingerprint === currentFingerprint &&
    ui.list.querySelector(".td-empty") === null;

  if (!canAppendOnly) {
    fullRebuildList(ui, state, store, visible);
    ui.list.dataset.fingerprint = currentFingerprint;
    return;
  }

  appendNewRowsAndPrune(ui, state, store, visible);
}

function fullRebuildList(
  ui: PanelUI,
  state: PanelState,
  store: EventStore,
  visible: readonly StoredEvent[],
): void {
  if (visible.length === 0) {
    ui.list.innerHTML = `<div class="td-empty">No events match the current filter.</div>`;
    return;
  }

  const wasAtBottom =
    ui.list.scrollHeight - ui.list.clientHeight - ui.list.scrollTop < 4;
  const prevScrollTop = ui.list.scrollTop;

  const html = visible.map((ev) => renderRow(ev, state, store)).join("");
  ui.list.innerHTML = html;

  ui.list.scrollTop = wasAtBottom ? ui.list.scrollHeight : prevScrollTop;
}

/**
 * Incremental update for the steady-state case: filter unchanged, new
 * events arriving at the tail of the ring buffer, oldest events possibly
 * evicted from the front.
 *
 * Preserves every row DOM node that is still visible. Critical for
 * in-flight user interactions (a click whose row gets `innerHTML =`d away
 * between pointerdown and click is silently dropped by the browser).
 */
function appendNewRowsAndPrune(
  ui: PanelUI,
  state: PanelState,
  store: EventStore,
  visible: readonly StoredEvent[],
): void {
  if (visible.length === 0) {
    ui.list.innerHTML = `<div class="td-empty">No events match the current filter.</div>`;
    return;
  }

  const wasAtBottom =
    ui.list.scrollHeight - ui.list.clientHeight - ui.list.scrollTop < 4;
  const prevScrollTop = ui.list.scrollTop;

  // Build a Set of visible seq numbers for O(1) lookup during pruning.
  const visibleSeqs = new Set<EventSeq>();
  for (const ev of visible) {
    visibleSeqs.add(ev.seq);
  }

  // Prune: drop any DOM rows whose seq is no longer in the visible set
  // (evicted from the ring buffer, or became invisible for some other
  // reason). We expect this to be a handful of rows per call at most.
  const existingRows = ui.list.querySelectorAll<HTMLElement>(".td-row");
  let lastSeqInDom: EventSeq = -1;
  for (const row of Array.from(existingRows)) {
    const seqAttr = row.dataset.seq;
    if (seqAttr === undefined) {
      row.remove();
      continue;
    }
    const seq = Number(seqAttr);
    if (!visibleSeqs.has(seq)) {
      row.remove();
    } else if (seq > lastSeqInDom) {
      lastSeqInDom = seq;
    }
  }

  // Append: any visible event with a seq greater than the last rendered one.
  // Events in `visible` are stored in insertion (seq) order, so we scan
  // forward until we cross the threshold.
  const toAppend: StoredEvent[] = [];
  for (const ev of visible) {
    if (ev.seq > lastSeqInDom) {
      toAppend.push(ev);
    }
  }
  if (toAppend.length > 0) {
    const html = toAppend.map((ev) => renderRow(ev, state, store)).join("");
    ui.list.insertAdjacentHTML("beforeend", html);
  }

  ui.list.scrollTop = wasAtBottom ? ui.list.scrollHeight : prevScrollTop;
}

function renderRow(
  ev: StoredEvent,
  state: PanelState,
  store: EventStore,
): string {
  const key = correlationKeyOf(ev);
  const first = store.firstInGroup(key);
  const selectedEvent =
    state.selectedSeq === null ? undefined : store.getBySeq(state.selectedSeq);
  const isSelected = state.selectedSeq === ev.seq;
  const isPairedToSelected =
    selectedEvent !== undefined &&
    !isSelected &&
    correlationKeyOf(selectedEvent) === key;

  const time = formatTime(ev.receivedAt);
  const classes = [
    "td-row",
    isSelected ? "selected" : "",
    isPairedToSelected ? "paired" : "",
    ev.kind === "system" ? "system" : "",
  ]
    .filter((c) => c !== "")
    .join(" ");

  const delta =
    first !== undefined && first.seq !== ev.seq
      ? ` <span class="td-latency">+${formatLatency(ev.receivedAt - first.receivedAt)}</span>`
      : "";

  if (ev.kind === "truapi") {
    return renderTruapiRow(ev, classes, time, delta);
  }
  return renderSystemRow(ev, classes, time, delta);
}

function renderTruapiRow(
  ev: StoredTruapiEvent,
  classes: string,
  time: string,
  delta: string,
): string {
  const arrow =
    ev.direction === "outgoing"
      ? `<span class="td-arrow-out">▶</span>`
      : `<span class="td-arrow-in">◀</span>`;
  const product =
    ev.productId === undefined
      ? `<span class="td-product anon">(no id)</span>`
      : `<span class="td-product" title="${escapeHtml(ev.productId)}">${escapeHtml(ev.productId)}</span>`;
  const ridShort = ev.requestId.slice(0, 6);
  const ridStyle = `color:${ridColor(ev.requestId)}`;
  const ridBadge = `<span class="td-rid" style="${ridStyle}" title="requestId: ${escapeHtml(ev.requestId)}">${escapeHtml(ridShort)}</span>`;

  const chain = decodeChainAnnotations(ev.tag, ev.payload);
  const displayTag = chain === null ? ev.tag : formatChainLabel(chain);
  const summary =
    chain === null ? formatPayloadSummary(ev.payload) : chainSummary(chain);

  return (
    `<div class="${classes}" data-seq="${String(ev.seq)}" data-rid="${escapeHtml(ev.requestId)}" role="listitem">` +
    `<span class="td-time">${time}</span>` +
    arrow +
    product +
    ridBadge +
    `<span class="td-tag-and-summary">` +
    `<span class="${tagClass(ev.tag)}">${escapeHtml(displayTag)}</span>${delta}` +
    (summary !== ""
      ? `<span class="td-summary">${escapeHtml(summary)}</span>`
      : "") +
    `</span>` +
    `</div>`
  );
}

function renderSystemRow(
  ev: StoredSystemEvent,
  classes: string,
  time: string,
  delta: string,
): string {
  const layerBadge = `<span class="td-layer-badge td-layer-${ev.layer}" title="source: ${ev.source}">${escapeHtml(ev.layer)}</span>`;
  const color = ridColor(ev.flowId);
  const flowBadge = `<span class="td-rid" style="color:${color}" title="flowId: ${escapeHtml(ev.flowId)}">${escapeHtml(ev.flowId.slice(0, 6))}</span>`;
  const summary = summariseSystemEvent(ev);
  const eventText = `${ev.layer}.${ev.event}`;
  return (
    `<div class="${classes}" data-seq="${String(ev.seq)}" data-rid="${escapeHtml(ev.flowId)}" role="listitem">` +
    `<span class="td-time">${time}</span>` +
    layerBadge +
    flowBadge +
    `<span class="td-tag-and-summary">` +
    `<span class="td-tag td-tag-sys">${escapeHtml(eventText)}</span>${delta}` +
    `<span class="td-summary">${escapeHtml(summary)}</span>` +
    `</span>` +
    `</div>`
  );
}

/**
 * Compact summary rendered in the list row for a decoded chain message.
 * Prioritises the correlation keys that distinguish similar rows:
 * block hash for head operations, operationId for started/received ops,
 * outcome for responses, error message for failures.
 */
function chainSummary(ann: ChainAnnotations): string {
  const parts: string[] = [];
  if (ann.chainEventTag !== undefined && ann.operationId !== undefined) {
    parts.push(`op ${shortHex(ann.operationId)}`);
  } else if (ann.operationId !== undefined) {
    parts.push(`op ${shortHex(ann.operationId)}`);
  }
  if (ann.blockHash !== undefined) {
    parts.push(`blk ${shortHex(ann.blockHash)}`);
  }
  if (ann.outcome === "error") {
    parts.push(`err: ${ann.errorMessage ?? "?"}`);
  } else if (ann.outcome === "limit-reached") {
    parts.push("limit-reached");
  }
  return parts.join(" · ");
}

/** Trim a 0x-prefixed hash or a long id down to a glance-friendly token. */
function shortHex(v: string): string {
  if (v.startsWith("0x") && v.length > 12) {
    return `${v.slice(0, 8)}…${v.slice(-4)}`;
  }
  if (v.length > 10) {
    return `${v.slice(0, 8)}…`;
  }
  return v;
}

/** Deterministic hue for a requestId. The same id yields the same color on every row. */
function ridColor(rid: string): string {
  let h = 0;
  for (let i = 0; i < rid.length; i++) {
    h = (h * 31 + rid.charCodeAt(i)) | 0;
  }
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${String(hue)}, 65%, 65%)`;
}

function tagClass(tag: string): string {
  if (
    tag.endsWith("_request") ||
    tag.endsWith("_start") ||
    tag.endsWith("_submit")
  ) {
    return "td-tag td-tag-req";
  }
  if (tag.endsWith("_response")) {
    return "td-tag td-tag-res";
  }
  if (
    tag.endsWith("_receive") ||
    tag.endsWith("_interrupt") ||
    tag.endsWith("_stop") ||
    tag.endsWith("_subscribe")
  ) {
    return "td-tag td-tag-sub";
  }
  return "td-tag";
}

function renderDetail(ui: PanelUI, state: PanelState, store: EventStore): void {
  if (state.selectedSeq === null) {
    ui.detail.innerHTML = `<div class="td-detail-empty">Select an event on the left to inspect its payload.</div>`;
    return;
  }
  const ev = store.getBySeq(state.selectedSeq);
  if (ev === undefined) {
    ui.detail.innerHTML = `<div class="td-detail-empty">Selected event was evicted from the ring buffer.</div>`;
    return;
  }

  if (state.view === "timeline") {
    ui.detail.innerHTML = renderGroupDetail(ev, store);
    return;
  }
  ui.detail.innerHTML = renderSingleDetail(ev, store);
}

/**
 * List-view detail: one event's full detail, with clickable pill links
 * to sibling events in the same requestId group so the user can jump
 * between request, response, or subscription receives.
 */
function renderSingleDetail(ev: StoredEvent, store: EventStore): string {
  if (ev.kind === "truapi") {
    return renderTruapiSingleDetail(ev, store);
  }
  return renderSystemSingleDetail(ev, store);
}

function renderTruapiSingleDetail(
  ev: StoredTruapiEvent,
  store: EventStore,
): string {
  const key = ev.requestId;
  const group = store.eventsInGroup(key);
  const first = store.firstInGroup(key);
  const siblings = group.filter((g) => g.seq !== ev.seq);
  const groupHtml = renderSiblingsHtml(ev, first, siblings);

  const ridBadge = `<span class="td-rid" style="color:${ridColor(ev.requestId)}">${escapeHtml(ev.requestId.slice(0, 6))}</span>`;
  const chain = decodeChainAnnotations(ev.tag, ev.payload);
  const summarySection = renderSummarySection(chain, ev.payload);
  const chainSection = chain === null ? "" : renderChainSection(chain);

  return (
    `<dl class="td-detail-head">` +
    `<dt>time</dt><dd>${formatTime(ev.receivedAt)}</dd>` +
    `<dt>direction</dt><dd>${ev.direction}</dd>` +
    `<dt>product</dt><dd>${ev.productId === undefined ? "(no id)" : escapeHtml(ev.productId)}</dd>` +
    `<dt>tag</dt><dd>${escapeHtml(ev.tag)}</dd>` +
    `<dt>requestId</dt><dd>${ridBadge} <code>${escapeHtml(ev.requestId)}</code></dd>` +
    `<dt>group</dt><dd>${String(group.length)} event${group.length === 1 ? "" : "s"}${siblings.length > 0 ? ` — ${groupHtml}` : ""}</dd>` +
    `</dl>` +
    summarySection +
    chainSection +
    `<pre class="td-detail-pre">${escapeHtml(formatPayloadDetail(ev.payload))}</pre>`
  );
}

function renderSystemSingleDetail(
  ev: StoredSystemEvent,
  store: EventStore,
): string {
  const key = ev.flowId;
  const group = store.eventsInGroup(key);
  const first = store.firstInGroup(key);
  const siblings = group.filter((g) => g.seq !== ev.seq);
  const groupHtml = renderSiblingsHtml(ev, first, siblings);
  const flowBadge = `<span class="td-rid" style="color:${ridColor(ev.flowId)}">${escapeHtml(ev.flowId.slice(0, 6))}</span>`;
  const summary = summariseSystemEvent(ev);

  return (
    `<dl class="td-detail-head">` +
    `<dt>time</dt><dd>${formatTime(ev.receivedAt)}</dd>` +
    `<dt>source</dt><dd>${ev.source}</dd>` +
    `<dt>layer</dt><dd>${escapeHtml(ev.layer)}</dd>` +
    `<dt>event</dt><dd>${escapeHtml(ev.event)}</dd>` +
    `<dt>flowId</dt><dd>${flowBadge} <code>${escapeHtml(ev.flowId)}</code></dd>` +
    `<dt>group</dt><dd>${String(group.length)} event${group.length === 1 ? "" : "s"}${siblings.length > 0 ? ` — ${groupHtml}` : ""}</dd>` +
    `</dl>` +
    `<div class="td-detail-section-title">Summary</div>` +
    `<div class="td-detail-summary">${escapeHtml(summary)}</div>` +
    renderExplanationSection(ev) +
    `<pre class="td-detail-pre">${escapeHtml(formatPayloadDetail(ev.payload))}</pre>`
  );
}

/**
 * Collapsible "What is this?" section rendered under the one-line
 * summary. Uses native `<details>`/`<summary>` so keyboard + assistive
 * tech work out of the box; CSS styles the disclosure without
 * replacing the native behaviour.
 */
function renderExplanationSection(ev: StoredSystemEvent): string {
  const explanation = getSystemExplanation(ev.layer, ev.event);
  if (explanation === undefined) {
    return "";
  }
  return (
    `<details class="td-detail-explanation">` +
    `<summary>What is this? — ${escapeHtml(explanation.title)}</summary>` +
    `<div class="td-detail-explanation-body">${renderExplanationBody(explanation.body)}</div>` +
    `</details>`
  );
}

/**
 * Render an explanation body string as HTML. Preserves paragraph
 * breaks (blank lines) and keeps `code` spans with backticks so the
 * prose can reference identifiers without being mistaken for literal
 * text. Plain text otherwise, with no Markdown engine dependency.
 */
function renderExplanationBody(body: string): string {
  const paragraphs = body.split(/\n\n+/);
  return paragraphs.map(renderExplanationParagraph).join("");
}

function renderExplanationParagraph(paragraph: string): string {
  // Backticked `identifiers` become <code>identifiers</code>. Bullet lines
  // (`• ` prefix) become list items.
  const lines = paragraph.split("\n");
  const isBulletList = lines.every(
    (l) => l.trim().startsWith("• ") || l.trim() === "",
  );
  if (isBulletList) {
    const items = lines
      .filter((l) => l.trim() !== "")
      .map((l) => {
        const content = l.trim().slice(2);
        return `<li>${formatInlineCode(content)}</li>`;
      })
      .join("");
    return `<ul class="td-detail-explanation-list">${items}</ul>`;
  }
  return `<p>${formatInlineCode(paragraph)}</p>`;
}

function formatInlineCode(text: string): string {
  // Escape first, then turn escaped backtick runs into <code> spans.
  // Because escaping produces `&#39;`/`&amp;` sequences we keep the
  // backtick search on the escaped string. It still identifies the
  // literal `\`…\`` boundaries.
  const escaped = escapeHtml(text);
  return escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** Shared rendering of sibling pills for the single-event detail view. */
function renderSiblingsHtml(
  ev: StoredEvent,
  first: StoredEvent | undefined,
  siblings: StoredEvent[],
): string {
  if (siblings.length === 0) {
    return "(no siblings in buffer)";
  }
  return siblings
    .map((s) => {
      const deltaMs = first === undefined ? 0 : s.receivedAt - first.receivedAt;
      const sign = ev.receivedAt > s.receivedAt ? "−" : "+";
      const deltaRelToSelected = Math.abs(s.receivedAt - ev.receivedAt);
      const label =
        s.kind === "truapi"
          ? `${escapeHtml(s.tag)} ${sign}${formatLatency(deltaRelToSelected)}`
          : `${escapeHtml(s.layer)}.${escapeHtml(s.event)} ${sign}${formatLatency(deltaRelToSelected)}`;
      return (
        `<span class="td-detail-pair" data-seq="${String(s.seq)}"` +
        ` title="seq ${String(s.seq)} · +${formatLatency(deltaMs)} from start">` +
        label +
        `</span>`
      );
    })
    .join(" · ");
}

/**
 * Human-readable one-liner describing what a chain message does. Shown
 * at the top of the detail pane so the reader doesn't have to parse
 * the JSON payload to understand the message intent.
 */
function renderSummarySection(
  chain: ChainAnnotations | null,
  payload: unknown,
): string {
  if (chain === null) {
    return "";
  }
  const summary = summariseChainMessage(chain, payload);
  if (summary === null) {
    return "";
  }
  return (
    `<div class="td-detail-section-title">Summary</div>` +
    `<div class="td-detail-summary">${escapeHtml(summary)}</div>`
  );
}

/**
 * Timeline-view detail: every member of the clicked box's requestId
 * group, stacked chronologically. Each member shows its decoded chain
 * annotations (if any) and its payload. Since all siblings are visible
 * together, no cross-link pills are needed. Clicking a box is a
 * "show me the whole handshake" action, not a "pick one message" one.
 */
function renderGroupDetail(ev: StoredEvent, store: EventStore): string {
  const key = correlationKeyOf(ev);
  const group = store.eventsInGroup(key);
  const first = store.firstInGroup(key);
  const keyBadge = `<span class="td-rid" style="color:${ridColor(key)}">${escapeHtml(key.slice(0, 6))}</span>`;

  const last = group.length > 0 ? group[group.length - 1] : undefined;
  const durationRow =
    first !== undefined && last !== undefined && first.seq !== last.seq
      ? `<dt>duration</dt><dd>${formatLatency(last.receivedAt - first.receivedAt)}</dd>`
      : "";

  const headerRows: string[] = [];
  if (ev.kind === "truapi") {
    headerRows.push(
      `<dt>requestId</dt><dd>${keyBadge} <code>${escapeHtml(ev.requestId)}</code></dd>`,
      `<dt>product</dt><dd>${ev.productId === undefined ? "(no id)" : escapeHtml(ev.productId)}</dd>`,
    );
  } else {
    headerRows.push(
      `<dt>flowId</dt><dd>${keyBadge} <code>${escapeHtml(ev.flowId)}</code></dd>`,
      `<dt>source</dt><dd>${ev.source}</dd>`,
      `<dt>layer</dt><dd>${escapeHtml(ev.layer)}</dd>`,
    );
  }
  headerRows.push(
    `<dt>group</dt><dd>${String(group.length)} event${group.length === 1 ? "" : "s"}</dd>`,
  );
  if (durationRow !== "") {
    headerRows.push(durationRow);
  }
  const header = `<dl class="td-detail-head">${headerRows.join("")}</dl>`;

  const members = group
    .map((m) => {
      const deltaMs = first === undefined ? 0 : m.receivedAt - first.receivedAt;
      const deltaLabel =
        first !== undefined && first.seq !== m.seq
          ? `<span class="td-latency">+${formatLatency(deltaMs)}</span>`
          : "";
      return m.kind === "truapi"
        ? renderTruapiMemberBlock(m, deltaLabel)
        : renderSystemMemberBlock(m, deltaLabel);
    })
    .join("");

  return header + members;
}

function renderTruapiMemberBlock(
  m: StoredTruapiEvent,
  deltaLabel: string,
): string {
  const arrow =
    m.direction === "outgoing"
      ? `<span class="td-arrow-out">▶</span>`
      : `<span class="td-arrow-in">◀</span>`;
  const chain = decodeChainAnnotations(m.tag, m.payload);
  const summaryBlock = renderSummarySection(chain, m.payload);
  const chainBlock = chain === null ? "" : renderChainSection(chain);
  return (
    `<div class="td-detail-member" data-seq="${String(m.seq)}">` +
    `<div class="td-detail-member-header">` +
    `<span class="td-time">${formatTime(m.receivedAt)}</span> ` +
    arrow +
    ` <span class="${tagClass(m.tag)}">${escapeHtml(m.tag)}</span> ` +
    deltaLabel +
    `</div>` +
    summaryBlock +
    chainBlock +
    `<pre class="td-detail-pre">${escapeHtml(formatPayloadDetail(m.payload))}</pre>` +
    `</div>`
  );
}

function renderSystemMemberBlock(
  m: StoredSystemEvent,
  deltaLabel: string,
): string {
  const summary = summariseSystemEvent(m);
  return (
    `<div class="td-detail-member" data-seq="${String(m.seq)}">` +
    `<div class="td-detail-member-header">` +
    `<span class="td-time">${formatTime(m.receivedAt)}</span> ` +
    `<span class="td-layer-badge td-layer-${m.layer}">${escapeHtml(m.layer)}</span> ` +
    `<span class="td-tag td-tag-sys">${escapeHtml(m.event)}</span> ` +
    deltaLabel +
    `</div>` +
    `<div class="td-detail-summary">${escapeHtml(summary)}</div>` +
    renderExplanationSection(m) +
    `<pre class="td-detail-pre">${escapeHtml(formatPayloadDetail(m.payload))}</pre>` +
    `</div>`
  );
}

/**
 * Chain-specific annotation block rendered above the raw payload in
 * the detail pane. Exists to surface the JSON-RPC correlation keys
 * (genesisHash, followSubscriptionId, operationId, blockHash, event
 * tag, outcome) that are buried inside the payload and would otherwise
 * require the reader to mentally parse the pretty-printed JSON.
 */
function renderChainSection(ann: ChainAnnotations): string {
  const rows: string[] = [];
  rows.push(`<dt>method</dt><dd>${escapeHtml(formatChainLabel(ann))}</dd>`);
  if (ann.chainEventTag !== undefined) {
    rows.push(`<dt>event</dt><dd>${escapeHtml(ann.chainEventTag)}</dd>`);
  }
  if (ann.genesisHash !== undefined) {
    rows.push(
      `<dt>genesis</dt><dd><code>${escapeHtml(ann.genesisHash)}</code></dd>`,
    );
  }
  if (ann.followSubscriptionId !== undefined) {
    rows.push(
      `<dt>followSub</dt><dd><code>${escapeHtml(ann.followSubscriptionId)}</code></dd>`,
    );
  }
  if (ann.operationId !== undefined) {
    rows.push(
      `<dt>opId</dt><dd><code>${escapeHtml(ann.operationId)}</code></dd>`,
    );
  }
  if (ann.blockHash !== undefined) {
    rows.push(
      `<dt>blockHash</dt><dd><code>${escapeHtml(ann.blockHash)}</code></dd>`,
    );
  }
  if (ann.outcome !== undefined) {
    const outcomeClass =
      ann.outcome === "error" ? "td-outcome-err" : "td-outcome-ok";
    const outcomeText =
      ann.outcome === "error" && ann.errorMessage !== undefined
        ? `error: ${ann.errorMessage}`
        : ann.outcome;
    rows.push(
      `<dt>outcome</dt><dd class="${outcomeClass}">${escapeHtml(outcomeText)}</dd>`,
    );
  }
  return (
    `<div class="td-detail-section-title">Chain</div>` +
    `<dl class="td-detail-head td-chain-head">${rows.join("")}</dl>`
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatLatency(ms: number): string {
  if (ms < 1) {
    return "<1ms";
  }
  if (ms < 1000) {
    return `${String(Math.round(ms))}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) {
    return;
  }
  const link = document.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  // The CSS is bundled next to this file; Vite resolves the URL.
  link.href = new URL("./styles.css", import.meta.url).href;
  document.head.appendChild(link);
}
