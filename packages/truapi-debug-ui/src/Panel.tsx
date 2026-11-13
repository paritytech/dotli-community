// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Rendering rules the parts rely on:
// - The store is not reactive. `snapshot` copies it at most once per frame, and synchronously on user actions.
//   A collapsed panel takes no snapshots.
// - User actions apply synchronously via `flush`. Never call `flush()` from an effect, memo or `onSettled`,
//   which already run inside Solid's update pass and would re-enter it.
// - The detail pane rebuilds only on user actions (`detailRevision`), never on traffic.

import { createMemo, createSignal, flush, onCleanup, onSettled, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { useStore } from '@dotli/stores-solid';
import { dockStorage, type DockPosition } from './model/createDockStorage.js';
import type { EventStore } from './model/createEventStore.js';
import { getCorrelationKey } from './model/getCorrelationKey.js';
import { findFirstNewIndex } from './model/findFirstNewIndex.js';
import type { EventSeq, StoredEvent } from './model/storedEvent.js';
import { buildExport, type ExportMeta } from './model/buildExport.js';
import { createInitialFilterState, type FilterState } from './model/filterState.js';
import { getPanelDockInset } from './model/getPanelDockInset.js';
import { sectionStorage, type PanelSection } from './model/createSectionStorage.js';

import type { ResolutionRecorder } from './model/createResolutionRecorder.js';
import { Diagnostics } from './Diagnostics.js';
import { DetailPane } from './DetailPane.js';
import { EventList, type Selection } from './EventList.js';
import { EventControls } from './EventControls.js';
import { EventFilters } from './EventFilters.js';
import { PanelEffectsContext, type PanelEffects } from './panelEffects.js';
import { Header } from './Header.js';
import {
  BodySplitter,
  clearPanelSize,
  clearSplit,
  ResizeHandle,
  restorePanelHeight,
  takePanelHeight,
} from './Resizers.js';
import { ArchiveView } from './ArchiveView.js';
import type { DebugPanelHost } from './host.js';
import { ResolutionView } from './ResolutionView.js';
import { SECTION_PANEL_ID, SECTION_TABS_ID } from './SectionTabs.js';
import { getTabId } from './shared/Tabs.js';
import { ViewTabs, VIEW_PANEL_ID, VIEW_TABS_ID, type PanelView } from './ViewTabs.js';
import { TimelineView } from './TimelineView.js';
import { WalletView } from './WalletView.js';
import { usePanelWork, type PanelWork } from './panelWork.js';
import s from './Panel.module.css';

type Snapshot = {
  events: readonly StoredEvent[];
  dropped: number;
  paused: boolean;
  /** Sorted, `undefined` last. */
  products: readonly (string | undefined)[];
  version: number;
  takenAt: number;
};

/** The events the filters let through, with the snapshot and filters they were taken from. */
type Filtered = {
  shown: readonly StoredEvent[];
  events: readonly StoredEvent[];
  filters: FilterState;
};

type FormatCountsParams = {
  /** Events in the snapshot. */
  total: number;
  /** Events evicted from the ring buffer. */
  dropped: number;
  /** Events the filters let through. */
  shown: number;
};

type RefitParams = {
  /** The size a drag just set, in px. Without it, the panel box is read. */
  size?: number;
};

type SetCollapsedToParams = {
  /** Run in the same pass as an unfold. */
  update?: () => void;
};

type AppendVisibleParams = {
  /** The visible list the last update returned. */
  previous: readonly StoredEvent[];
  /** The snapshot's events at the last update. */
  lastEvents: readonly StoredEvent[];
  /** The snapshot's events now. */
  events: readonly StoredEvent[];
  /** The filters both updates applied. */
  filters: FilterState;
  /** Whether an event passes the filters. */
  matches: PanelWork['matchesFilters'];
};

export const PANEL_ID = 'truapi-debug-panel';

/** The panel keeps its own kit, so it holds this width itself: below it the panel docks at the bottom, panes stacked. */
export const NARROW_QUERY = '(max-width: 560px)';

export function Panel(props: {
  store: EventStore;
  /** The host events of the last page load, held apart from `store`. */
  resolution: ResolutionRecorder;
  startCollapsed: boolean;
  host: DebugPanelHost;
  /** What the panel asks of the browser: the clipboard and a download. */
  effects: PanelEffects;
}): JSX.Element {
  const store = untrack(() => props.store);
  const recorder = untrack(() => props.resolution);
  const host = untrack(() => props.host);
  const { matchesFilters } = usePanelWork();

  let panelElement: HTMLDivElement | undefined;
  let listElement: HTMLDivElement | undefined;
  let tooltipElement: HTMLDivElement | undefined;
  let expandedHeight = '';

  const takeSnapshot = (): Snapshot => ({
    // A snapshot holds still while traffic keeps arriving.
    events: store.list().slice(),
    dropped: store.dropped(),
    paused: store.isPaused(),
    products: sortProducts(store.productIds()),
    version: store.version.get(),
    takenAt: Date.now(),
  });

  const [snapshot, setSnapshot] = createSignal<Snapshot>(takeSnapshot());
  const [filters, setFilters] = createSignal<FilterState>(createInitialFilterState());
  const section = useStore(sectionStorage);
  const [view, setView] = createSignal<PanelView>('list');
  const [resolutionCleared, setResolutionCleared] = createSignal(0);
  const eventsShown = (): boolean => section() === 'truapi';
  const listShown = (): boolean => eventsShown() && view() === 'list';
  const [selection, setSelection] = createSignal<Selection | null>(null);
  const [collapsed, setCollapsed] = createSignal(untrack(() => props.startCollapsed));
  const dock = useStore(dockStorage);
  const narrowViewport = window.matchMedia(NARROW_QUERY);
  const [narrow, setNarrow] = createSignal(narrowViewport.matches);
  const placement = createMemo<DockPosition>(() => (narrow() ? 'bottom' : dock()));
  const stacked = createMemo(() => placement() === 'right' || narrow());
  const [detailRevision, setDetailRevision] = createSignal(0);

  // Under the same filters, a new snapshot only appends to the last result, so the list keeps its unchanged rows.
  const filtered = createMemo<Filtered>(last => {
    const events = snapshot().events;
    const current = filters();
    if (last?.filters !== current) {
      return { shown: events.filter(e => matchesFilters(e, current)), events, filters: current };
    }
    const shown = appendVisible({
      previous: last.shown,
      lastEvents: last.events,
      events,
      filters: current,
      matches: matchesFilters,
    });
    return { shown, events, filters: current };
  });
  // A memo, so a frame that shows nothing new keeps the same list and redraws nothing.
  const visible = createMemo(() => filtered().shown);
  // Keyed on the recorder, not the store, so TrUAPI traffic does not redraw the Resolution view.
  const resolutionVersion = createMemo(() => {
    snapshot();
    resolutionCleared();
    return recorder.version();
  });

  const counts = (): string =>
    formatCounts({ total: snapshot().events.length, dropped: snapshot().dropped, shown: visible().length });

  function refreshDetail(): void {
    setDetailRevision(n => n + 1);
  }

  /** Apply `update` synchronously, keeping the list pinned to the bottom or to its top row as rows are evicted. */
  function commit(update: () => void): void {
    const list = listElement;
    const wasAtBottom = list !== undefined && list.scrollHeight - list.clientHeight - list.scrollTop < 4;
    const previousScrollTop = list?.scrollTop ?? 0;
    const anchor = list !== undefined && !wasAtBottom ? findTopRow(list, previousScrollTop) : null;
    const anchorTop = anchor?.offsetTop ?? 0;
    flush(update);
    if (list === undefined || !listShown() || list.querySelector('[data-seq]') === null) {
      return;
    }
    if (wasAtBottom) {
      list.scrollTop = list.scrollHeight;
    } else if (anchor?.isConnected === true) {
      list.scrollTop = previousScrollTop + anchor.offsetTop - anchorTop;
    } else {
      list.scrollTop = previousScrollTop;
    }
  }

  function refreshSnapshot(): void {
    if (store.version.get() !== untrack(snapshot).version) {
      setSnapshot(takeSnapshot());
    }
  }

  let frame: number | null = null;
  const unlistenStore = store.version.listen(() => {
    if (frame !== null) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = null;
      // A collapsed panel shows nothing of the log, and expanding takes a snapshot.
      if (store.version.get() === snapshot().version || collapsed()) {
        return;
      }
      commit(() => setSnapshot(takeSnapshot()));
    });
  });
  onCleanup(() => {
    unlistenStore();
    if (frame !== null) {
      cancelAnimationFrame(frame);
    }
  });

  // Reports only when the panel box changes. A drag passes the size it just set, so nothing reads layout back.
  function refit({ size }: RefitParams = {}): void {
    host.reportDockInset(
      getPanelDockInset({
        collapsed: collapsed(),
        dock: placement(),
        width: size ?? panelElement?.offsetWidth ?? 0,
        height: size ?? panelElement?.offsetHeight ?? 0,
      }),
    );
  }
  onCleanup(() => {
    host.reportDockInset({ right: 0, bottom: 0 });
  });

  /** Each orientation starts from its CSS defaults, so inline resize and split sizes are cleared. */
  function applyDockLayout(): void {
    hideTooltip();
    const panel = panelElement;
    if (panel === undefined) {
      return;
    }
    clearPanelSize(panel);
    // The stashed pre-collapse height belongs to the previous orientation.
    expandedHeight = '';
    clearSplit(panel);
    // Right dock sits below the topbar so its controls stay reachable.
    switch (placement()) {
      case 'right':
        panel.style.top = host.topbarPresent() ? 'var(--td-content-top)' : '0';
        break;
      case 'bottom':
        panel.style.top = '';
        break;
    }
    refit();
  }
  onSettled(() => {
    applyDockLayout();
  });
  function handleViewportChange(event: MediaQueryListEvent): void {
    flush(() => setNarrow(event.matches));
    applyDockLayout();
  }
  narrowViewport.addEventListener('change', handleViewportChange);
  onCleanup(() => {
    narrowViewport.removeEventListener('change', handleViewportChange);
  });

  function select(seq: EventSeq): void {
    const event = store.getBySeq(seq);
    flush(() => {
      setSelection({
        seq,
        key: event === undefined ? null : getCorrelationKey(event),
      });
      refreshDetail();
    });
  }

  const isShown = (seq: EventSeq | undefined): boolean => seq !== undefined && visible().some(e => e.seq === seq);

  // The detail pane rebuilds only when the selected event leaves or enters the list.
  function changeFilters(next: FilterState): void {
    const selected = selection()?.seq;
    const wasShown = isShown(selected);
    commit(() => {
      setFilters(next);
      refreshSnapshot();
    });
    if (isShown(selected) !== wasShown) {
      flush(refreshDetail);
    }
  }

  /** Hides the tooltip, since hiding, moving or folding the pane under the cursor may fire no boundary event. */
  function hideTooltip(): void {
    tooltipElement?.removeAttribute('data-visible');
  }

  /** Switches what the panel shows, keeping the list pinned and the detail pane in step. */
  function show(update: () => void): void {
    hideTooltip();
    commit(() => {
      update();
      refreshSnapshot();
      refreshDetail();
    });
  }
  /** Folds the panel to its header, or unfolds it running `update` in the same pass. */
  function setCollapsedTo(next: boolean, { update }: SetCollapsedToParams = {}): void {
    hideTooltip();
    applyCollapsedHeight(next);
    if (next) {
      flush(() => setCollapsed(true));
    } else {
      commit(() => {
        update?.();
        setCollapsed(false);
        refreshSnapshot();
      });
    }
    refit();
  }
  /** Stashes the panel's inline height on a fold and puts it back on an unfold. */
  function applyCollapsedHeight(next: boolean): void {
    const panel = panelElement;
    if (panel === undefined) {
      return;
    }
    if (next) {
      // An inline drag height would override the collapsed height rule, so stash it until expand.
      expandedHeight = takePanelHeight(panel);
      return;
    }
    restorePanelHeight(panel, expandedHeight);
  }
  function selectSection(next: PanelSection): void {
    if (collapsed()) {
      setCollapsedTo(false, {
        update() {
          sectionStorage.set(next);
          refreshDetail();
        },
      });
    } else if (next !== section()) {
      show(() => {
        sectionStorage.set(next);
      });
    }
  }
  function selectView(next: PanelView): void {
    if (next !== view()) {
      show(() => setView(next));
    }
  }

  /** Exports carry the filtered view, what the user currently sees. */
  function exportJson(): string {
    const events = visible();
    const meta: ExportMeta = {
      exportedAt: new Date().toISOString(),
      url: window.location.href,
      userAgent: navigator.userAgent,
      capacity: store.capacity,
      droppedCount: snapshot().dropped,
      totalEvents: snapshot().events.length,
      exportedEvents: events.length,
      filters: filters(),
    };
    return buildExport(events, meta);
  }

  return (
    <PanelEffectsContext value={props.effects}>
      <div
        id={PANEL_ID}
        class={s['panel']}
        data-dock={placement()}
        data-layout={stacked() ? 'stacked' : undefined}
        data-section={section()}
        data-view={eventsShown() ? view() : undefined}
        data-collapsed={collapsed() ? '' : undefined}
        style={{ '--td-content-top': host.contentInsets.top, '--td-content-bottom': host.contentInsets.bottom }}
        ref={element => {
          panelElement = element;
        }}
      >
        <ResizeHandle
          panel={() => panelElement}
          collapsed={collapsed()}
          dock={placement()}
          onResize={size => {
            refit({ size });
          }}
        />
        <Header
          section={section()}
          onSelectSection={selectSection}
          collapsed={collapsed()}
          dock={dock()}
          placement={placement()}
          onExit={() => {
            host.leaveDebugMode();
          }}
          onToggleDock={() => {
            flush(() => {
              dockStorage.set(getOtherDock(dock()));
            });
            applyDockLayout();
          }}
          onToggleCollapse={() => {
            setCollapsedTo(!collapsed());
          }}
        />
        <EventFilters
          filters={filters()}
          products={snapshot().products}
          hidden={collapsed() || !eventsShown()}
          onChange={changeFilters}
          controls={
            <EventControls
              counts={counts()}
              paused={snapshot().paused}
              exportJson={exportJson}
              onTogglePause={() => {
                store.setPaused(!store.isPaused());
                commit(refreshSnapshot);
              }}
              onClear={() => {
                store.clear();
                // The detail pane rebuilds only on request, so rebuild now or the old event lingers.
                flush(() => {
                  setSelection(null);
                  refreshDetail();
                });
              }}
            />
          }
        />
        <div
          id={SECTION_PANEL_ID}
          class={s['body']}
          data-testid="td-body"
          role="tabpanel"
          aria-labelledby={getTabId(SECTION_TABS_ID, section())}
        >
          <div class={s['views']} data-testid="td-views">
            <ViewTabs view={view()} hidden={!eventsShown()} onSelect={selectView} />
            <div
              id={VIEW_PANEL_ID}
              class={s['viewPanel']}
              data-testid="td-view-panel"
              role="tabpanel"
              aria-labelledby={getTabId(VIEW_TABS_ID, view())}
              hidden={!eventsShown()}
            >
              <EventList
                events={visible()}
                allEvents={snapshot().events}
                refreshedAt={snapshot().takenAt}
                store={store}
                selection={selection()}
                active={listShown()}
                collapsed={collapsed()}
                onSelect={select}
                listRef={element => {
                  listElement = element;
                }}
              />
              <TimelineView
                active={eventsShown() && view() === 'timeline'}
                events={visible()}
                selectedSeq={selection()?.seq ?? null}
                tooltip={() => tooltipElement}
                panel={() => panelElement}
                onSelect={select}
              />
            </div>
            <ResolutionView
              active={section() === 'resolution'}
              collapsed={collapsed()}
              refresh={resolutionVersion()}
              recorder={recorder}
              tooltip={() => tooltipElement}
              panel={() => panelElement}
              onClear={() => {
                recorder.clear();
                flush(() => setResolutionCleared(n => n + 1));
              }}
            />
            <ArchiveView active={section() === 'archive'} load={host.archive} product={host.product} />
            <Diagnostics active={section() === 'diagnostics'} source={host.diagnostics} />
            <WalletView active={section() === 'wallet'} host={host} />
          </div>
          <BodySplitter panel={() => panelElement} stacked={stacked()} hidden={!eventsShown()} />
          <DetailPane
            revision={detailRevision()}
            selectedSeq={selection()?.seq ?? null}
            view={view()}
            store={store}
            hidden={!eventsShown()}
            onSelectPair={seq => {
              select(seq);
              listElement
                ?.querySelector<HTMLElement>(`[data-seq="${String(seq)}"]`)
                ?.scrollIntoView({ block: 'nearest' });
            }}
          />
        </div>
        <div
          class={s['tooltip']}
          data-testid="td-tooltip"
          aria-hidden="true"
          ref={element => {
            tooltipElement = element;
          }}
        />
      </div>
    </PanelEffectsContext>
  );
}

/**
 * The visible list after the store evicted or appended events under the same filters: `previous` without the evicted
 * events, followed by the new events that pass the filters. Returns `previous` unchanged when nothing was evicted or
 * added, so the list keeps its identity.
 */
function appendVisible({
  previous,
  lastEvents,
  events,
  filters,
  matches,
}: AppendVisibleParams): readonly StoredEvent[] {
  const firstSeq = events[0]?.seq ?? Infinity;
  const kept = previous.findIndex(e => e.seq >= firstSeq);
  const dropped = kept === -1 ? previous.length : kept;
  const added: StoredEvent[] = [];
  for (let index = findFirstNewIndex(lastEvents, events); index < events.length; index++) {
    const event = events[index];
    if (event !== undefined && matches(event, filters)) {
      added.push(event);
    }
  }
  if (dropped === 0 && added.length === 0) {
    return previous;
  }
  return [...previous.slice(dropped), ...added];
}

/** The first row still in view at `scrollTop`, by bisection over offsets relative to the first row. */
function findTopRow(list: HTMLElement, scrollTop: number): HTMLElement | null {
  const rows = list.children;
  const first = rows[0];
  if (!(first instanceof HTMLElement)) {
    return null;
  }
  const target = scrollTop + first.offsetTop;
  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    const row = rows[middle];
    if (row instanceof HTMLElement && row.offsetTop + row.offsetHeight > target) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  const top = rows[low];
  return top instanceof HTMLElement ? top : null;
}

function sortProducts(products: readonly (string | undefined)[]): (string | undefined)[] {
  return [...products].sort((left, right) => {
    if (left === undefined) {
      return 1;
    }
    if (right === undefined) {
      return -1;
    }
    return left.localeCompare(right);
  });
}

function formatCounts({ total, dropped, shown }: FormatCountsParams): string {
  const totalLabel = dropped > 0 ? `${String(total)} events (+${String(dropped)} dropped)` : `${String(total)} events`;
  const filterNote = shown !== total ? ` · ${String(shown)} shown` : '';
  return `${totalLabel}${filterNote}`;
}

function getOtherDock(dock: DockPosition): DockPosition {
  switch (dock) {
    case 'right':
      return 'bottom';
    case 'bottom':
      return 'right';
  }
}
