// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Rendering rules the parts rely on:
// - The store is not reactive. `snapshot` copies it at most once per frame, and synchronously on user actions.
//   A collapsed panel takes no snapshots.
// - User actions apply synchronously via `flush`. Never call `flush()` from an effect, memo or `onSettled`,
//   which already run inside Solid's update pass and would re-enter it.
// - The detail pane rebuilds only on user actions (`detailRevision`), never on traffic.

import { createEffect, createMemo, createSignal, flush, onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { useStore } from '@dotli/stores-solid';
import { dockStorage, type DockPosition } from './model/createDockStorage.js';
import type { EventStore } from './model/createEventStore.js';
import { getCorrelationKey } from './model/getCorrelationKey.js';
import type { EventSeq, StoredEvent } from './model/storedEvent.js';
import { buildExport, type ExportMeta } from './model/buildExport.js';
import { createInitialFilterState, type FilterState } from './model/filterState.js';
import { getPanelDockInset } from './model/getPanelDockInset.js';
import { sectionStorage, type PanelSection } from './model/createSectionStorage.js';
import { appendVisible } from './model/appendVisible.js';
import { formatListCounts, type ListCounts } from './model/formatListCounts.js';

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
import { usePanelWork } from './panelWork.js';
import { createPanelSnapshot } from './createPanelSnapshot.js';
import { pinListScroll } from './pinListScroll.js';
import s from './Panel.module.css';

/** The events the filters let through, with the snapshot and filters they were taken from. */
type Filtered = {
  shown: readonly StoredEvent[];
  events: readonly StoredEvent[];
  filters: FilterState;
};

type RefitParams = {
  /** The size a drag just set, in px. Without it, the panel box is read. */
  size?: number;
};

type UnfoldParams = {
  /** Run in the same pass as the unfold. */
  update?: () => void;
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

  const [filters, setFilters] = createSignal<FilterState>(createInitialFilterState());
  const section = useStore(sectionStorage);
  const [view, setView] = createSignal<PanelView>('list');
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
  const { snapshot, refresh: refreshSnapshot } = createPanelSnapshot({ store, recorder, collapsed, apply: commit });

  // Under the same filters, a new snapshot only appends to the last result, so the list keeps its unchanged rows.
  const filtered = createMemo<Filtered>(last => {
    const events = snapshot().events;
    const current = filters();
    const shown =
      last?.filters === current
        ? appendVisible({
            previous: last.shown,
            lastEvents: last.events,
            events,
            passes: e => matchesFilters(e, current),
          })
        : events.filter(e => matchesFilters(e, current));
    return { shown, events, filters: current };
  });
  // A memo, so a frame that shows nothing new keeps the same list and redraws nothing.
  const visible = createMemo(() => filtered().shown);
  // Read with each snapshot, so an event the ring evicts stops counting as hidden.
  const selectionFilteredOut = createMemo((): boolean => {
    const current = filtered().filters;
    const selected = selection();
    const event = selected === null ? undefined : store.getBySeq(selected.seq);
    return event !== undefined && !matchesFilters(event, current);
  });
  // Keyed on the recorder, not the store, so TrUAPI traffic does not redraw the Resolution view.
  const resolutionVersion = createMemo(() => snapshot().resolutionVersion);

  const counts = (): ListCounts =>
    formatListCounts({ total: snapshot().events.length, dropped: snapshot().dropped, shown: visible().length });

  function refreshDetail(): void {
    setDetailRevision(n => n + 1);
  }

  /** Apply `update` synchronously, keeping the list pinned to the bottom or to its top row as rows are evicted. */
  function commit(update: () => void): void {
    if (listElement === undefined) {
      flush(update);
      return;
    }
    pinListScroll(listElement, () => flush(update));
  }

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
  // A narrow switch on a bottom dock changes the stacking but not the placement.
  createEffect(
    () => [placement(), stacked()],
    () => {
      applyDockLayout();
    },
  );
  function handleViewportChange(event: MediaQueryListEvent): void {
    flush(() => setNarrow(event.matches));
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

  // The detail pane shows no filter, so a filter change leaves it alone.
  function changeFilters(next: FilterState): void {
    commit(() => {
      setFilters(next);
      refreshSnapshot();
    });
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
  /** Folds the panel to its header. */
  function fold(): void {
    hideTooltip();
    if (panelElement !== undefined) {
      // An inline drag height would override the collapsed height rule, so stash it until unfold.
      expandedHeight = takePanelHeight(panelElement);
    }
    flush(() => setCollapsed(true));
    refit();
  }
  /** Unfolds the panel, running `update` in the same pass. */
  function unfold({ update }: UnfoldParams = {}): void {
    hideTooltip();
    if (panelElement !== undefined) {
      restorePanelHeight(panelElement, expandedHeight);
    }
    commit(() => {
      update?.();
      setCollapsed(false);
      refreshSnapshot();
    });
    refit();
  }
  function selectSection(next: PanelSection): void {
    if (collapsed()) {
      unfold({
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
          }}
          onToggleCollapse={() => {
            if (collapsed()) {
              unfold();
            } else {
              fold();
            }
          }}
        />
        <EventFilters
          filters={filters()}
          products={snapshot().products}
          hidden={collapsed() || !eventsShown()}
          onChange={changeFilters}
          controls={
            <EventControls
              paused={snapshot().paused}
              exportJson={exportJson}
              onTogglePause={() => {
                store.setPaused(!store.isPaused());
                commit(refreshSnapshot);
              }}
              onClear={() => {
                store.clear();
                // The detail pane rebuilds only on request, so rebuild now or the old event lingers.
                commit(() => {
                  setSelection(null);
                  refreshSnapshot();
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
            <ViewTabs view={view()} counts={counts()} hidden={!eventsShown()} onSelect={selectView} />
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
                flush(refreshSnapshot);
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
            events={snapshot().events}
            hidden={!eventsShown()}
            filteredOut={selectionFilteredOut()}
            onSelectPair={select}
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

function getOtherDock(dock: DockPosition): DockPosition {
  switch (dock) {
    case 'right':
      return 'bottom';
    case 'bottom':
      return 'right';
  }
}
