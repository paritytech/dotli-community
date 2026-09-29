// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// TrUAPI debug panel: a docked, resizable panel listing dotli-internal debug
// events. Holds the panel state as signals and wires the parts together.
//
// Rendering rules the parts rely on:
// - The store is not reactive. `snapshot` is a copy of it, refreshed at most
//   once per animation frame from `store.subscribe`, and synchronously on a
//   user action that re-reads the store (filter change, tab swap). A
//   collapsed panel takes no snapshots: it keeps only its header count, from
//   the events that arrived, and expanding catches up once.
// - Per-frame work follows what changed, not what is retained: `visible`
//   filters only the events a snapshot added, and returns the same array
//   when the visible set did not change.
// - User actions apply synchronously (`flush`), as the imperative panel did:
//   the DOM reflects a click or keypress before the handler returns. Never
//   call `flush()` from an effect, a memo, or `onSettled` — those already
//   run inside Solid's own update pass, and forcing a nested flush there
//   would re-enter it.
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
  correlationKeyOf,
  firstNewIndex,
  type EventSeq,
  type EventStore,
  type StoredEvent,
  buildExport,
  type ExportMeta,
  initialFilterState,
  matches,
  type FilterState,
  panelDockInset,
} from "@dotli/truapi-debug";

import type { ResolutionRecorder } from "@dotli/truapi-debug";
import { setDockInset } from "../../product-frame-layout.js";
import { DetailPane } from "./DetailPane.js";
import { EventList, type Selection } from "./EventList.js";
import { Filters } from "./Filters.js";
import { Header } from "./Header.js";
import { BodySplitter, ResizeHandle } from "./Resizers.js";
import { ResolutionView } from "./ResolutionView.js";
import { Tabs, type PanelView } from "./Tabs.js";
import { TimelineView } from "./TimelineView.js";

export const PANEL_ID = "truapi-debug-panel";

/**
 * The first row still in view at `scrollTop`, found by bisection over the
 * rows' offsets (relative to the first row, so the list's own offset drops
 * out). Null for an empty list.
 */
function topRow(list: HTMLElement, scrollTop: number): HTMLElement | null {
  const rows = list.children;
  const first = rows[0] as HTMLElement | undefined;
  if (first === undefined) {
    return null;
  }
  const target = scrollTop + first.offsetTop;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const row = rows[mid] as HTMLElement;
    if (row.offsetTop + row.offsetHeight > target) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return rows[lo] as HTMLElement;
}

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

/**
 * How many of the store's events a filter shows, kept up to date from the
 * live ring buffer at a cost proportional to the events that arrived or left.
 * What a collapsed panel's header count reads.
 */
class ShownCounter {
  /** Seqs of the shown events, in order, from `head` on. */
  private seqs: EventSeq[] = [];
  private head = 0;
  private lastSeq = -1;
  private filters: FilterState | null = null;

  /** Start from what the panel last drew. */
  seed(
    shown: readonly StoredEvent[],
    events: readonly StoredEvent[],
    filters: FilterState,
  ): void {
    this.seqs = shown.map((e) => e.seq);
    this.head = 0;
    this.lastSeq = events.at(-1)?.seq ?? -1;
    this.filters = filters;
  }

  count(events: readonly StoredEvent[], filters: FilterState): number {
    if (filters !== this.filters) {
      this.seed([], [], filters);
    }
    const firstSeq = events[0]?.seq ?? Infinity;
    let headSeq = this.seqs[this.head];
    while (headSeq !== undefined && headSeq < firstSeq) {
      this.head++;
      headSeq = this.seqs[this.head];
    }
    for (
      let i = firstNewIndex({ lastSeq: this.lastSeq }, events);
      i < events.length;
      i++
    ) {
      const ev = events[i];
      if (ev !== undefined && matches(ev, filters)) {
        this.seqs.push(ev.seq);
      }
    }
    const lastEvent = events.at(-1);
    if (lastEvent !== undefined) {
      this.lastSeq = lastEvent.seq;
    }
    if (this.head > 1024) {
      this.seqs = this.seqs.slice(this.head);
      this.head = 0;
    }
    return this.seqs.length - this.head;
  }
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

  /** The events and filters `visible` last filtered. */
  let filtered: {
    events: readonly StoredEvent[];
    filters: FilterState;
  } | null = null;
  const visible = createMemo<readonly StoredEvent[]>((prev) => {
    const events = snapshot().events;
    const current = filters();
    const last = filtered;
    filtered = { events, filters: current };
    if (prev === undefined || last?.filters !== current) {
      return events.filter((e) => matches(e, current));
    }
    // Same filters: drop what left the head, filter only what was appended.
    const firstSeq = events[0]?.seq ?? Infinity;
    const kept = prev.findIndex((e) => e.seq >= firstSeq);
    const dropped = kept === -1 ? prev.length : kept;
    const added: StoredEvent[] = [];
    for (let i = firstNewIndex(last.events, events); i < events.length; i++) {
      const ev = events[i];
      if (ev !== undefined && matches(ev, current)) {
        added.push(ev);
      }
    }
    if (dropped === 0 && added.length === 0) {
      return prev;
    }
    return dropped === 0
      ? [...prev, ...added]
      : [...prev.slice(dropped), ...added];
  });
  // The Resolution view draws the recorder, not the store: TrUAPI traffic
  // (most of it) leaves this unchanged, so it does not redraw.
  const resolutionVersion = createMemo(() => {
    snapshot();
    return recorder.version();
  });

  // While collapsed, the header count follows the store without a snapshot.
  const shown = new ShownCounter();
  const [collapsedCounts, setCollapsedCounts] = createSignal<string | null>(
    null,
  );
  if (untrack(collapsed)) {
    untrack(() => {
      shown.seed(visible(), snapshot().events, filters());
    });
  }
  const counts = (): string =>
    collapsedCounts() ??
    countsLabel(snapshot().events.length, snapshot().dropped, visible().length);

  const refreshDetail = (): void => {
    setDetailRevision((n) => n + 1);
  };

  /**
   * Apply `update` synchronously, keeping the list pinned to the bottom if it
   * was there. Otherwise the row at the top of the view stays where it was,
   * even as rows are evicted above it at capacity.
   */
  const commit = (update: () => void): void => {
    const list = listEl;
    const wasAtBottom =
      list !== undefined &&
      list.scrollHeight - list.clientHeight - list.scrollTop < 4;
    const prevScrollTop = list?.scrollTop ?? 0;
    const anchor =
      list !== undefined && !wasAtBottom ? topRow(list, prevScrollTop) : null;
    const anchorTop = anchor?.offsetTop ?? 0;
    flush(update);
    if (
      list !== undefined &&
      view() === "list" &&
      list.querySelector(".td-row") !== null
    ) {
      if (wasAtBottom) {
        list.scrollTop = list.scrollHeight;
      } else if (anchor?.isConnected === true) {
        list.scrollTop = prevScrollTop + anchor.offsetTop - anchorTop;
      } else {
        list.scrollTop = prevScrollTop;
      }
    }
  };

  /** Re-read the store, unless nothing changed since the last snapshot. */
  const refreshSnapshot = (): void => {
    if (store.version() !== untrack(snapshot).version) {
      setSnapshot(takeSnapshot());
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
      if (store.version() === snapshot().version) {
        return;
      }
      // No rows are on screen: only the header count follows, and
      // expanding catches up.
      if (collapsed()) {
        const events = store.list();
        const label = countsLabel(
          events.length,
          store.dropped(),
          shown.count(events, filters()),
        );
        flush(() => setCollapsedCounts(label));
        return;
      }
      commit(() => setSnapshot(takeSnapshot()));
    });
  });
  onCleanup(() => {
    unsubscribeStore();
    if (frame !== null) {
      cancelAnimationFrame(frame);
    }
  });

  // The frame layout keeps the inset across product reloads and bar moves,
  // so it only needs reporting when the panel's own box changes. A drag
  // passes the size it just set (`size`), so nothing reads layout back.
  const refit = (size?: number): void => {
    setDockInset(
      panelDockInset({
        collapsed: collapsed(),
        dock: dock(),
        width: size ?? panelEl?.offsetWidth ?? 0,
        height: size ?? panelEl?.offsetHeight ?? 0,
      }),
      "debug",
    );
  };
  onCleanup(() => {
    setDockInset({ right: 0, bottom: 0 }, "debug");
  });

  /**
   * Lay the panel out for the current dock: clear inline resize overrides and
   * split sizes (each orientation starts from its CSS default), pin the top,
   * and refit the product iframe.
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

  const isShown = (seq: EventSeq | undefined): boolean =>
    seq !== undefined && visible().some((e) => e.seq === seq);

  // The detail pane does not depend on the filters: it is rebuilt only when
  // the selected event leaves or enters the list.
  const changeFilters = (next: FilterState): void => {
    const selected = selection()?.seq;
    const wasShown = isShown(selected);
    commit(() => {
      setFilters(next);
      refreshSnapshot();
    });
    if (isShown(selected) !== wasShown) {
      flush(refreshDetail);
    }
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
      refreshSnapshot();
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
          if (next) {
            shown.seed(visible(), snapshot().events, filters());
            flush(() => setCollapsed(true));
          } else {
            commit(() => {
              setCollapsed(false);
              setCollapsedCounts(null);
              refreshSnapshot();
            });
          }
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
            collapsed={collapsed()}
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
            refresh={resolutionVersion()}
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
