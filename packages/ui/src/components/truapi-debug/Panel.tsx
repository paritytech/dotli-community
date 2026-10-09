// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Rendering rules the parts rely on:
// - The store is not reactive. `snapshot` copies it at most once per frame, and synchronously on user actions.
//   A collapsed panel takes no snapshots and only updates its header count.
// - User actions apply synchronously via `flush`. Never call `flush()` from an effect, memo or `onSettled`,
//   which already run inside Solid's update pass and would re-enter it.
// - The detail pane rebuilds only on user actions (`detailRevision`), never on traffic.

import { createEffect, createMemo, createSignal, flush, onCleanup, onSettled, Show, untrack } from 'solid-js';
import { DEBUG } from '@dotli/config';
import type { ExperimentalWalletControls } from '@dotli/truapi-debug';
import type { JSX } from '@solidjs/web';
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
} from '@dotli/truapi-debug';

import type { ResolutionRecorder } from '@dotli/truapi-debug';
import { setDockInset } from '../../product-frame-layout.js';
import { getTopbarState } from '../../state/topbar.js';
import { DiagnosticsView } from './Diagnostics.js';
import { DetailPane } from './DetailPane.js';
import { EventList, type Selection } from './EventList.js';
import { Filters } from './Filters.js';
import { Header } from './Header.js';
import { BodySplitter, ResizeHandle } from './Resizers.js';
import { ArchiveView } from './ArchiveView.js';
import type { ArchiveLoader } from './archive-source.js';
import { ResolutionView } from './ResolutionView.js';
import { Tabs, type PanelView } from './Tabs.js';
import { TimelineView } from './TimelineView.js';
import { createWalletController } from './wallet/controller.js';
import { WalletView } from './wallet/WalletView.js';
import s from './Panel.module.css';

export const PANEL_ID = 'truapi-debug-panel';

/** Below this the panel docks at the bottom with panes stacked, whatever dock was picked. Matches Header.module.css. */
const NARROW_QUERY = '(max-width: 560px)';

/** The first row still in view at `scrollTop`, by bisection over offsets relative to the first row. */
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

interface Snapshot {
  events: readonly StoredEvent[];
  dropped: number;
  /** Sorted, `undefined` last. */
  products: readonly (string | undefined)[];
  version: number;
  takenAt: number;
}

function sortProducts(products: (string | undefined)[]): (string | undefined)[] {
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

/** The collapsed header's shown count, updated at a cost proportional to the events that arrived or left. */
class ShownCounter {
  /** Valid from `head` on. */
  private seqs: EventSeq[] = [];
  private head = 0;
  private lastSeq = -1;
  private filters: FilterState | null = null;

  seed(shown: readonly StoredEvent[], events: readonly StoredEvent[], filters: FilterState): void {
    this.seqs = shown.map(e => e.seq);
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
    for (let i = firstNewIndex({ lastSeq: this.lastSeq }, events); i < events.length; i++) {
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
  const totalLabel = dropped > 0 ? `${String(total)} events (+${String(dropped)} dropped)` : `${String(total)} events`;
  const filterNote = shown !== total ? ` · ${String(shown)} shown` : '';
  return `${totalLabel}${filterNote}`;
}

export function Panel(props: {
  store: EventStore;
  /** Kept apart from the ring buffer so a busy session cannot evict the load the Resolution view draws. */
  resolution: ResolutionRecorder;
  startCollapsed: boolean;
  wallet?: ExperimentalWalletControls | undefined;
  loadArchive: ArchiveLoader;
}): JSX.Element {
  const store = untrack(() => props.store);
  const recorder = untrack(() => props.resolution);

  let panelEl: HTMLDivElement | undefined;
  let listEl: HTMLDivElement | undefined;
  let tooltipEl: HTMLDivElement | undefined;
  let expandedHeight = '';

  const takeSnapshot = (): Snapshot => ({
    // `list()` is the live ring buffer.
    events: store.list().slice(),
    dropped: store.dropped(),
    products: sortProducts(store.productIds()),
    version: store.version(),
    takenAt: Date.now(),
  });

  const [snapshot, setSnapshot] = createSignal<Snapshot>(takeSnapshot());
  const [filters, setFilters] = createSignal<FilterState>(initialFilterState());
  const [view, setView] = createSignal<PanelView>('list');
  const [selection, setSelection] = createSignal<Selection | null>(null);
  const [collapsed, setCollapsed] = createSignal(untrack(() => props.startCollapsed));
  const [dock, setDock] = createSignal<DockPosition>(readStoredDock());
  const narrowViewport = window.matchMedia(NARROW_QUERY);
  const [narrow, setNarrow] = createSignal(narrowViewport.matches);
  const placement = createMemo<DockPosition>(() => (narrow() ? 'bottom' : dock()));
  const stacked = createMemo(() => placement() === 'right' || narrow());
  const [paused, setPaused] = createSignal(store.isPaused());
  const [detailRevision, setDetailRevision] = createSignal(0);

  let filtered: {
    events: readonly StoredEvent[];
    filters: FilterState;
  } | null = null;
  const visible = createMemo<readonly StoredEvent[]>(prev => {
    const events = snapshot().events;
    const current = filters();
    const last = filtered;
    filtered = { events, filters: current };
    if (prev === undefined || last?.filters !== current) {
      return events.filter(e => matches(e, current));
    }
    // Same filters: filter only what was appended, and keep the array identity when nothing changed.
    const firstSeq = events[0]?.seq ?? Infinity;
    const kept = prev.findIndex(e => e.seq >= firstSeq);
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
    return dropped === 0 ? [...prev, ...added] : [...prev.slice(dropped), ...added];
  });
  // Keyed on the recorder, not the store, so TrUAPI traffic does not redraw the Resolution view.
  const resolutionVersion = createMemo(() => {
    snapshot();
    return recorder.version();
  });

  const shown = new ShownCounter();
  const [collapsedCounts, setCollapsedCounts] = createSignal<string | null>(null);
  if (untrack(collapsed)) {
    untrack(() => {
      shown.seed(visible(), snapshot().events, filters());
    });
  }
  const counts = (): string =>
    collapsedCounts() ?? countsLabel(snapshot().events.length, snapshot().dropped, visible().length);

  const refreshDetail = (): void => {
    setDetailRevision(n => n + 1);
  };

  /** Apply `update` synchronously, keeping the list pinned to the bottom or to its top row as rows are evicted. */
  const commit = (update: () => void): void => {
    const list = listEl;
    const wasAtBottom = list !== undefined && list.scrollHeight - list.clientHeight - list.scrollTop < 4;
    const prevScrollTop = list?.scrollTop ?? 0;
    const anchor = list !== undefined && !wasAtBottom ? topRow(list, prevScrollTop) : null;
    const anchorTop = anchor?.offsetTop ?? 0;
    flush(update);
    if (list !== undefined && view() === 'list' && list.querySelector('[data-seq]') !== null) {
      if (wasAtBottom) {
        list.scrollTop = list.scrollHeight;
      } else if (anchor?.isConnected === true) {
        list.scrollTop = prevScrollTop + anchor.offsetTop - anchorTop;
      } else {
        list.scrollTop = prevScrollTop;
      }
    }
  };

  const refreshSnapshot = (): void => {
    if (store.version() !== untrack(snapshot).version) {
      setSnapshot(takeSnapshot());
    }
  };

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
      if (collapsed()) {
        const events = store.list();
        const label = countsLabel(events.length, store.dropped(), shown.count(events, filters()));
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

  // The frame layout keeps the inset across reloads, so report only when the panel box changes.
  // A drag passes the size it just set, so nothing reads layout back.
  const refit = (size?: number): void => {
    setDockInset(
      panelDockInset({
        collapsed: collapsed(),
        dock: placement(),
        width: size ?? panelEl?.offsetWidth ?? 0,
        height: size ?? panelEl?.offsetHeight ?? 0,
      }),
      'debug',
    );
  };
  onCleanup(() => {
    setDockInset({ right: 0, bottom: 0 }, 'debug');
  });

  /** Each orientation starts from its CSS defaults, so inline resize and split sizes are cleared. */
  const applyDockLayout = (persist: boolean): void => {
    const el = panelEl;
    if (el === undefined) {
      return;
    }
    el.style.height = '';
    el.style.width = '';
    // The stashed pre-collapse height belongs to the previous orientation.
    expandedHeight = '';
    el.style.removeProperty('--td-left-width');
    el.style.removeProperty('--td-top-height');
    // Right dock sits below the topbar so its controls stay reachable.
    if (placement() === 'right') {
      el.style.top = getTopbarState().present ? 'var(--content-top)' : '0';
    } else {
      el.style.top = '';
    }
    if (persist) {
      writeStoredDock(dock());
    }
    refit();
  };
  onSettled(() => {
    applyDockLayout(false);
  });
  const onViewportChange = (e: MediaQueryListEvent): void => {
    flush(() => setNarrow(e.matches));
    applyDockLayout(false);
  };
  narrowViewport.addEventListener('change', onViewportChange);
  onCleanup(() => {
    narrowViewport.removeEventListener('change', onViewportChange);
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

  const isShown = (seq: EventSeq | undefined): boolean => seq !== undefined && visible().some(e => e.seq === seq);

  // The detail pane rebuilds only when the selected event leaves or enters the list.
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

  const splitView = (): boolean => view() === 'list' || view() === 'timeline';

  const selectView = (next: PanelView): void => {
    if (next === view()) {
      return;
    }
    // Hiding the pane under the cursor may fire no boundary event, which would strand the tooltip.
    tooltipEl?.removeAttribute('data-visible');
    commit(() => {
      setView(next);
      refreshSnapshot();
      refreshDetail();
    });
  };

  /** Exports carry the filtered view, what the user currently sees. */
  const exportJson = (): string => {
    const all = store.list();
    const current = filters();
    const events = all.filter(e => matches(e, current));
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

  // Like ResolutionView, the Wallet view's DOM is owned by this Solid root.
  // Keep the safety-sensitive controller across tab swaps; visibility clears
  // secrets and invalidates late reads, while disposal removes all listeners.
  const wallet = untrack(() => (DEBUG ? props.wallet : undefined));
  const walletController = wallet === undefined ? undefined : createWalletController(wallet, store);
  const openWallet = (): void => {
    if (walletController === undefined) {
      return;
    }
    if (collapsed()) {
      if (panelEl !== undefined && expandedHeight !== '') {
        panelEl.style.height = expandedHeight;
      }
      commit(() => {
        setCollapsed(false);
        setCollapsedCounts(null);
        refreshSnapshot();
      });
    }
    selectView('wallet');
    refit();
    walletController.focus();
  };
  createEffect(
    () => view() === 'wallet' && !collapsed(),
    visible => walletController?.setVisible(visible),
  );
  if (walletController !== undefined) {
    window.addEventListener('dotli:wallet-open', openWallet);
  }
  onCleanup(() => {
    window.removeEventListener('dotli:wallet-open', openWallet);
    walletController?.dispose();
  });

  return (
    <div
      id={PANEL_ID}
      class={s['panel']}
      data-dock={placement()}
      data-layout={stacked() ? 'stacked' : undefined}
      data-view={view()}
      data-collapsed={collapsed() ? '' : undefined}
      ref={el => {
        panelEl = el;
      }}
    >
      <ResizeHandle panel={() => panelEl} collapsed={collapsed()} dock={placement()} onResize={refit} />
      <Header
        wallet={
          walletController === undefined
            ? undefined
            : {
                name: walletController.ui().entryName,
                expanded: walletController.ui().opened,
                onOpen: openWallet,
              }
        }
        counts={counts()}
        paused={paused()}
        collapsed={collapsed()}
        dock={dock()}
        placement={placement()}
        exportJson={exportJson}
        onTogglePause={() => {
          const next = !store.isPaused();
          store.setPaused(next);
          flush(() => setPaused(next));
        }}
        onClear={() => {
          store.clear();
          recorder.clear();
          // The detail pane rebuilds only on request, so rebuild now or the old event lingers.
          flush(() => {
            setSelection(null);
            refreshDetail();
          });
        }}
        onToggleDock={() => {
          flush(() => setDock(dock() === 'bottom' ? 'right' : 'bottom'));
          applyDockLayout(true);
        }}
        onToggleCollapse={() => {
          const next = !collapsed();
          const el = panelEl;
          if (el !== undefined) {
            if (next) {
              // An inline drag height would override the collapsed height rule, so stash it until expand.
              expandedHeight = el.style.height;
              el.style.height = '';
            } else if (expandedHeight !== '') {
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
        placement={placement()}
        collapsed={collapsed()}
        hidden={view() === 'wallet'}
        onChange={changeFilters}
      />
      <div class={s['body']} data-testid="td-body">
        <div class={s['views']} data-testid="td-views">
          <Tabs view={view()} wallet={walletController !== undefined} onSelect={selectView} />
          <Show when={walletController}>{controller => <WalletView controller={controller()} />}</Show>
          <EventList
            events={visible()}
            allEvents={snapshot().events}
            refreshedAt={snapshot().takenAt}
            store={store}
            selection={selection()}
            active={view() === 'list'}
            collapsed={collapsed()}
            onSelect={select}
            listRef={el => {
              listEl = el;
            }}
          />
          <TimelineView
            active={view() === 'timeline'}
            events={visible()}
            selectedSeq={selection()?.seq ?? null}
            tooltip={() => tooltipEl}
            panel={() => panelEl}
            onSelect={select}
          />
          <ResolutionView
            active={view() === 'resolution'}
            collapsed={collapsed()}
            refresh={resolutionVersion()}
            recorder={recorder}
            tooltip={() => tooltipEl}
            panel={() => panelEl}
          />
          <ArchiveView active={view() === 'archive'} load={props.loadArchive} />
          <DiagnosticsView active={view() === 'diagnostics'} />
        </div>
        <BodySplitter panel={() => panelEl} stacked={stacked()} hidden={!splitView()} />
        <DetailPane
          revision={detailRevision()}
          selectedSeq={selection()?.seq ?? null}
          view={view()}
          store={store}
          hidden={!splitView()}
          onSelectPair={seq => {
            select(seq);
            listEl?.querySelector<HTMLElement>(`[data-seq="${String(seq)}"]`)?.scrollIntoView({ block: 'nearest' });
          }}
        />
      </div>
      <div
        class={s['tooltip']}
        data-testid="td-tooltip"
        aria-hidden="true"
        ref={el => {
          tooltipEl = el;
        }}
      />
    </div>
  );
}
