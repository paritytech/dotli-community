// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// TrUAPI debug panel: a docked, resizable panel listing dotli-internal debug
// events. Holds the panel state as signals and wires the parts together.
//
// Rendering rules the parts rely on:
// - The store is not reactive. `snapshot` is a copy of it, refreshed at most
//   once per animation frame from `store.subscribe`, and synchronously on a
//   user action that re-reads the store (filter change, tab swap).
// - User actions apply synchronously (`flush`), as the imperative panel did:
//   the DOM reflects a click or keypress before the handler returns.
// - The detail pane is rebuilt only on user actions (`detailRevision`), never
//   because traffic arrived.

import {
  createMemo,
  createSignal,
  flush,
  onCleanup,
  onSettled,
  untrack,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  readStoredDock,
  writeStoredDock,
  type DockPosition,
} from "@dotli/truapi-debug/dock-storage";
import {
  correlationKeyOf,
  type EventSeq,
  type EventStore,
  type StoredEvent,
} from "@dotli/truapi-debug/event-store";
import { buildExport, type ExportMeta } from "@dotli/truapi-debug/export";
import {
  initialFilterState,
  matches,
  type FilterState,
} from "@dotli/truapi-debug/filters";
import { adjustIframeForPanel } from "@dotli/truapi-debug/iframe-layout";
import type { ResolutionRecorder } from "@dotli/truapi-debug/resolution-view";
import { DetailPane } from "./DetailPane";
import { EventList, type Selection } from "./EventList";
import { Filters } from "./Filters";
import { Header } from "./Header";
import { BodySplitter, ResizeHandle } from "./Resizers";
import { ResolutionView } from "./ResolutionView";
import { Tabs, type PanelView } from "./Tabs";
import { TimelineView } from "./TimelineView";

export const PANEL_ID = "truapi-debug-panel";

/** What the panel last read from the store. */
interface Snapshot {
  events: readonly StoredEvent[];
  dropped: number;
  /** Distinct product ids, sorted, `undefined` last. */
  products: readonly (string | undefined)[];
  version: number;
  takenAt: number;
}

function sortProducts(
  products: (string | undefined)[],
): (string | undefined)[] {
  return products.sort((a, b) => {
    if (a === undefined) {
      return 1;
    }
    if (b === undefined) {
      return -1;
    }
    return a.localeCompare(b);
  });
}

function countsLabel(total: number, dropped: number, shown: number): string {
  const totalLabel =
    dropped > 0
      ? `${String(total)} events (+${String(dropped)} dropped)`
      : `${String(total)} events`;
  const filterNote = shown !== total ? ` · ${String(shown)} shown` : "";
  return `${totalLabel}${filterNote}`;
}

export function Panel(props: {
  store: EventStore;
  /** Kept apart from the ring buffer so a busy session cannot evict the head
   *  of the load the Resolution view is drawing. */
  resolution: ResolutionRecorder;
  startCollapsed: boolean;
}): JSX.Element {
  const store = untrack(() => props.store);
  const recorder = untrack(() => props.resolution);

  let panelEl: HTMLDivElement | undefined;
  let listEl: HTMLDivElement | undefined;
  let tooltipEl: HTMLDivElement | undefined;
  /** Inline drag-resize height stashed while collapsed, restored on expand. */
  let expandedHeight = "";

  const takeSnapshot = (): Snapshot => ({
    // `list()` is the live ring buffer; copy it.
    events: store.list().slice(),
    dropped: store.dropped(),
    products: sortProducts(store.productIds()),
    version: store.version(),
    takenAt: Date.now(),
  });

  const [snapshot, setSnapshot] = createSignal<Snapshot>(takeSnapshot());
  const [filters, setFilters] = createSignal<FilterState>(initialFilterState());
  const [view, setView] = createSignal<PanelView>("list");
  const [selection, setSelection] = createSignal<Selection | null>(null);
  const [collapsed, setCollapsed] = createSignal(
    untrack(() => props.startCollapsed),
  );
  const [dock, setDock] = createSignal<DockPosition>(readStoredDock());
  const [paused, setPaused] = createSignal(store.isPaused());
  const [detailRevision, setDetailRevision] = createSignal(0);

  const visible = createMemo(() =>
    snapshot().events.filter((e) => matches(e, filters())),
  );
  const counts = (): string =>
    countsLabel(snapshot().events.length, snapshot().dropped, visible().length);

  const refreshDetail = (): void => {
    setDetailRevision((n) => n + 1);
  };

  /**
   * Apply `update` synchronously, keeping the list pinned to the bottom if it
   * was there, or at its scroll offset otherwise.
   */
  const commit = (update: () => void): void => {
    const list = listEl;
    const wasAtBottom =
      list !== undefined &&
      list.scrollHeight - list.clientHeight - list.scrollTop < 4;
    const prevScrollTop = list?.scrollTop ?? 0;
    flush(update);
    if (
      list !== undefined &&
      view() === "list" &&
      list.querySelector(".td-row") !== null
    ) {
      list.scrollTop = wasAtBottom ? list.scrollHeight : prevScrollTop;
    }
  };

  // Store traffic: one refresh per animation frame, however many events.
  let frame: number | null = null;
  const unsubscribeStore = store.subscribe(() => {
    if (frame !== null) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = null;
      if (store.version() !== snapshot().version) {
        commit(() => setSnapshot(takeSnapshot()));
      }
    });
  });
  onCleanup(() => {
    unsubscribeStore();
    if (frame !== null) {
      cancelAnimationFrame(frame);
    }
  });

  const refit = (): void => {
    adjustIframeForPanel({
      collapsed: collapsed(),
      dock: dock(),
      width: panelEl?.offsetWidth ?? 0,
      height: panelEl?.offsetHeight ?? 0,
    });
  };

  // When a new product iframe is mounted, re-apply the iframe size so the
  // panel doesn't cover freshly-rendered app content.
  window.addEventListener("dotli:product-loaded", refit);
  onCleanup(() => {
    window.removeEventListener("dotli:product-loaded", refit);
  });

  /**
   * Lay the panel out for the current dock: clear inline resize overrides and
   * split sizes (each orientation starts from its CSS default), pin the top,
   * and refit the host iframe.
   */
  const applyDockLayout = (persist: boolean): void => {
    const el = panelEl;
    if (el === undefined) {
      return;
    }
    el.style.height = "";
    el.style.width = "";
    // The stashed pre-collapse height belongs to the previous orientation.
    expandedHeight = "";
    el.style.removeProperty("--td-left-width");
    el.style.removeProperty("--td-top-height");
    // Right-dock sits below the host topbar (40px) so the dock toggle and
    // session controls remain reachable. Bottom-dock pins to the viewport
    // bottom edge.
    if (dock() === "right") {
      el.style.top = document.getElementById("topbar") !== null ? "40px" : "0";
    } else {
      el.style.top = "";
    }
    if (persist) {
      writeStoredDock(dock());
    }
    refit();
  };
  onSettled(() => {
    applyDockLayout(false);
  });

  const select = (seq: EventSeq): void => {
    const ev = store.getBySeq(seq);
    flush(() => {
      setSelection({
        seq,
        key: ev === undefined ? null : correlationKeyOf(ev),
      });
      refreshDetail();
    });
  };

  const changeFilters = (next: FilterState): void => {
    commit(() => {
      setFilters(next);
      setSnapshot(takeSnapshot());
      refreshDetail();
    });
  };

  const selectView = (next: PanelView): void => {
    if (next === view()) {
      return;
    }
    // `display: none` on the pane under the cursor is not guaranteed to fire
    // a boundary event, which would strand the tooltip over the page.
    tooltipEl?.classList.remove("visible");
    commit(() => {
      setView(next);
      setSnapshot(takeSnapshot());
      refreshDetail();
    });
  };

  /** Exports carry the filtered view — what the user currently sees. */
  const exportJson = (): string => {
    const all = store.list();
    const current = filters();
    const events = all.filter((e) => matches(e, current));
    const meta: ExportMeta = {
      exportedAt: new Date().toISOString(),
      url: window.location.href,
      userAgent: navigator.userAgent,
      capacity: store.capacity,
      droppedCount: store.dropped(),
      totalEvents: all.length,
      exportedEvents: events.length,
      filters: current,
    };
    return buildExport(events, meta);
  };

  return (
    <div
      id={PANEL_ID}
      class={{
        collapsed: collapsed(),
        "docked-right": dock() === "right",
        "res-view": view() === "resolution",
      }}
      ref={(el) => {
        panelEl = el;
      }}
    >
      <ResizeHandle
        panel={() => panelEl}
        collapsed={collapsed()}
        dock={dock()}
        onResize={refit}
      />
      <Header
        counts={counts()}
        paused={paused()}
        collapsed={collapsed()}
        dock={dock()}
        exportJson={exportJson}
        onTogglePause={() => {
          const next = !store.isPaused();
          store.setPaused(next);
          flush(() => setPaused(next));
        }}
        onClear={() => {
          store.clear();
          recorder.clear();
          // The list follows on the next frame; the detail pane only
          // rebuilds on request, so rebuild it now or the old event lingers.
          flush(() => {
            setSelection(null);
            refreshDetail();
          });
        }}
        onToggleDock={() => {
          flush(() => setDock(dock() === "bottom" ? "right" : "bottom"));
          applyDockLayout(true);
        }}
        onToggleCollapse={() => {
          const next = !collapsed();
          const el = panelEl;
          if (el !== undefined) {
            if (next) {
              // An inline drag-resize height would override the collapsed
              // 32px rule and leave an empty panel-sized box. Stash it while
              // collapsed and restore it on expand.
              expandedHeight = el.style.height;
              el.style.height = "";
            } else if (expandedHeight !== "") {
              el.style.height = expandedHeight;
            }
          }
          flush(() => setCollapsed(next));
          refit();
        }}
      />
      <Filters
        filters={filters()}
        products={snapshot().products}
        onChange={changeFilters}
      />
      <div class="td-body">
        <div class="td-views">
          <Tabs view={view()} onSelect={selectView} />
          <EventList
            events={visible()}
            allEvents={snapshot().events}
            refreshedAt={snapshot().takenAt}
            store={store}
            selection={selection()}
            active={view() === "list"}
            onSelect={select}
            listRef={(el) => {
              listEl = el;
            }}
          />
          <TimelineView
            active={view() === "timeline"}
            events={visible()}
            selectedSeq={selection()?.seq ?? null}
            tooltip={() => tooltipEl}
            panel={() => panelEl}
            onSelect={select}
          />
          <ResolutionView
            active={view() === "resolution"}
            collapsed={collapsed()}
            refresh={snapshot()}
            recorder={recorder}
            tooltip={() => tooltipEl}
            panel={() => panelEl}
          />
        </div>
        <BodySplitter panel={() => panelEl} dock={dock()} />
        <DetailPane
          revision={detailRevision()}
          selectedSeq={selection()?.seq ?? null}
          view={view()}
          store={store}
          onSelectPair={(seq) => {
            select(seq);
            listEl
              ?.querySelector<HTMLElement>(`.td-row[data-seq="${String(seq)}"]`)
              ?.scrollIntoView({ block: "nearest" });
          }}
        />
      </div>
      <div
        class="td-tooltip"
        aria-hidden="true"
        ref={(el) => {
          tooltipEl = el;
        }}
      />
    </div>
  );
}
