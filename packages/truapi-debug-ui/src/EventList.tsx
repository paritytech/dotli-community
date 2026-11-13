// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Rows are keyed by seq and must never be rebuilt under streaming traffic, because a browser drops a click
// whose target node is replaced between pointerdown and click.

import { createEffect, createMemo, createSignal, flush, For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { formatMemberDelta } from './model/formatMemberDelta.js';
import type { EventStore } from './model/createEventStore.js';
import { createOpenCallTracker, SLOW_AFTER_MS } from './model/createOpenCallTracker.js';
import { getCorrelationKey } from './model/getCorrelationKey.js';
import type { EventSeq, StoredEvent, StoredSystemEvent, StoredTruapiEvent } from './model/storedEvent.js';
import { getPendingKey } from './model/getPendingKey.js';
import { formatProductId } from './model/formatProductId.js';
import { toSystemRowData } from './model/toSystemRowData.js';
import { toTruapiRowData } from './model/toTruapiRowData.js';

import type { KeyedSignals } from './createKeyedSignals.js';
import { DirectionArrow } from './shared/DirectionArrow.js';
import { EmptyState } from './shared/EmptyState.js';
import { IdBadge } from './shared/IdBadge.js';
import { ITEM_CLASS, ITEM_LIST_CLASS } from './shared/ItemList.js';
import { LayerBadge } from './shared/LayerBadge.js';
import { Latency } from './shared/Latency.js';
import { MethodTag } from './shared/MethodTag.js';
import { PendingIcon } from './icons/PendingIcon.js';
import { Timestamp } from './shared/Timestamp.js';
import { usePanelWork, type PanelWork } from './panelWork.js';
import s from './EventList.module.css';

export type Selection = {
  seq: EventSeq;
  /** Correlation key. Events sharing it are `paired`. */
  key: string | null;
};

/** Per-key signals, so a selection or clock change re-runs only the rows it touches, not all of them. */
type RowContext = {
  selectedSeq: KeyedSignals<EventSeq, true>;
  /** By correlation key. */
  selectedKey: KeyedSignals<string, true>;
  /** Ms waited by each call still open, by pending key. */
  waiting: KeyedSignals<string, number>;
  work: Pick<PanelWork, 'formatPending' | 'getRowSelection'>;
};

type RenderRowParams = {
  event: StoredEvent;
  store: EventStore;
  context: RowContext;
};

type RenderCellsParams = {
  event: StoredEvent;
  /** The offset from the group's anchor, or `null` for the anchor itself. */
  latency: string | null;
  context: RowContext;
};

type MoveMarkParams<Key> = {
  /** The key that held the mark, or `null` when none did. */
  from: Key | null;
  /** The key that takes the mark, or `null` to leave it on none. */
  to: Key | null;
};

/** Pending badges tick on a clock, since a stalled host is exactly one that emits no events. */
const PENDING_TICK_MS = 1000;

export function EventList(props: {
  events: readonly StoredEvent[];
  /** Unfiltered, because a reply outside the filter still closes a call. */
  allEvents: readonly StoredEvent[];
  refreshedAt: number;
  store: EventStore;
  selection: Selection | null;
  active: boolean;
  collapsed: boolean;
  onSelect: (seq: EventSeq) => void;
  listRef: (element: HTMLDivElement) => void;
}): JSX.Element {
  let list: HTMLDivElement | undefined;
  const work = usePanelWork();

  // Written in effect functions, never in a compute.
  const selectedSeq = work.createKeyedSignals<EventSeq, true>();
  const selectedKey = work.createKeyedSignals<string, true>();
  createEffect(
    () => props.selection,
    (selection, previous = null) => {
      moveMark(selectedSeq, { from: previous?.seq ?? null, to: selection?.seq ?? null });
      moveMark(selectedKey, { from: previous?.key ?? null, to: selection?.key ?? null });
    },
  );

  const tracker = createOpenCallTracker();
  const [tickedAt, setTickedAt] = createSignal(0);
  createEffect(
    () => props.active && !props.collapsed,
    live => {
      if (!live) {
        return;
      }
      const tick = setInterval(() => {
        if (tracker.open().size > 0) {
          flush(() => setTickedAt(Date.now()));
        }
      }, PENDING_TICK_MS);
      return () => {
        clearInterval(tick);
      };
    },
  );

  // Traffic writes only the calls it opened or closed. A tick, or coming back on screen, rewrites every badge. Coming
  // back reads the clock, since the snapshot time and the last tick can be as old as the moment the list was hidden.
  const waiting = work.createKeyedSignals<string, number>();
  createEffect(
    () =>
      props.active && !props.collapsed
        ? {
            events: props.allEvents,
            tick: tickedAt(),
            now: Math.max(props.refreshedAt, tickedAt()),
          }
        : null,
    (input, previous = null) => {
      if (input === null) {
        return;
      }
      tracker.update(input.events);
      const open = tracker.open();
      // `previous` is null when the list was off screen.
      if (input.tick !== previous?.tick) {
        const now = previous === null ? Date.now() : input.now;
        for (const key of [...waiting.keys()]) {
          if (!open.has(key)) {
            waiting.write(key, undefined);
          }
        }
        for (const [key, since] of open) {
          waiting.write(key, now - since);
        }
        return;
      }
      for (const key of tracker.changedKeys()) {
        const since = open.get(key);
        waiting.write(key, since === undefined ? undefined : input.now - since);
      }
    },
  );

  const context: RowContext = { selectedSeq, selectedKey, waiting, work };

  // A selection a filter hides, or the ring evicted, has no option to point at.
  const activeRow = createMemo<string | undefined>(() => {
    const selected = props.selection;
    return selected !== null && props.events.some(e => e.seq === selected.seq) ? getRowId(selected.seq) : undefined;
  });

  return (
    <div
      class={[ITEM_LIST_CLASS, s['list']]}
      data-testid="td-list"
      hidden={!props.active}
      role="listbox"
      aria-label="Events"
      aria-activedescendant={activeRow()}
      tabindex="0"
      ref={element => {
        list = element;
        props.listRef(element);
      }}
      onClick={event => {
        if (!(event.target instanceof Element)) {
          return;
        }
        const row = event.target.closest<HTMLElement>('[data-seq]');
        const seqAttribute = row?.dataset['seq'];
        if (seqAttribute === undefined) {
          return;
        }
        // Otherwise arrow keys after a click scroll the page instead of stepping rows.
        list?.focus({ preventScroll: true });
        props.onSelect(Number(seqAttribute));
      }}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
          return;
        }
        const events = props.events;
        if (events.length === 0) {
          return;
        }
        event.preventDefault();
        const selected = props.selection;
        const currentIndex = selected === null ? -1 : events.findIndex(e => e.seq === selected.seq);
        let nextIndex: number;
        if (event.key === 'ArrowDown') {
          nextIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, events.length - 1);
        } else {
          nextIndex = currentIndex < 0 ? events.length - 1 : Math.max(currentIndex - 1, 0);
        }
        const nextSeq = events[nextIndex]?.seq;
        if (nextIndex === currentIndex || nextSeq === undefined) {
          return;
        }
        props.onSelect(nextSeq);
        list?.querySelector(`[data-seq="${String(nextSeq)}"]`)?.scrollIntoView({ block: 'nearest' });
      }}
    >
      <For
        each={props.events}
        keyed={e => e.seq}
        fallback={
          <div role="option" aria-disabled="true" aria-selected="false">
            <EmptyState testId="td-empty">No events match the current filter.</EmptyState>
          </div>
        }
      >
        {event => renderRow({ event: untrack(event), store: props.store, context })}
      </For>
    </div>
  );
}

function getRowId(seq: EventSeq): string {
  return `td-row-${String(seq)}`;
}

/** Clears the mark on `from` and sets it on `to`, touching nothing when they are the same key. */
function moveMark<Key>(marks: KeyedSignals<Key, true>, { from, to }: MoveMarkParams<Key>): void {
  if (from === to) {
    return;
  }
  if (from !== null) {
    marks.write(from, undefined);
  }
  if (to !== null) {
    marks.write(to, true);
  }
}

/**
 * One list row, reading its immutable event once.
 *
 * A helper, not a component, because dev builds wrap each component instance and the list would track one
 * source per row (HUGE_FAN_IN at capacity).
 */
function renderRow({ event, store, context }: RenderRowParams): JSX.Element {
  const key = getCorrelationKey(event);
  // The anchor is captured at insert time, so a row drawn after the group head was evicted keeps its latency.
  const latency = formatMemberDelta(event, store.anchorOf(event));

  const selection = (): string | undefined =>
    context.work.getRowSelection(context.selectedSeq.read(event.seq) === true, context.selectedKey.read(key) === true);

  return (
    <div
      class={[ITEM_CLASS, s['row']]}
      data-testid="td-row"
      data-selection={selection()}
      data-system={event.kind === 'system' ? '' : undefined}
      data-seq={String(event.seq)}
      id={getRowId(event.seq)}
      role="option"
      aria-selected={context.selectedSeq.read(event.seq) === true ? 'true' : 'false'}
    >
      <Timestamp at={event.receivedAt} />
      {renderCells({ event, latency, context })}
    </div>
  );
}

function renderCells({ event, latency, context }: RenderCellsParams): JSX.Element {
  switch (event.kind) {
    case 'truapi':
      return <TruapiCells event={event} latency={latency} context={context} />;
    case 'system':
      return <SystemCells event={event} latency={latency} />;
  }
}

function TruapiCells(props: { event: StoredTruapiEvent; latency: string | null; context: RowContext }): JSX.Element {
  const event = untrack(() => props.event);
  const context = untrack(() => props.context);
  const data = toTruapiRowData(event);
  const pendingKey = getPendingKey(event);
  const waiting = (): number | undefined => (pendingKey === null ? undefined : context.waiting.read(pendingKey));

  return (
    <>
      <DirectionArrow direction={event.direction} />
      <span
        class={s['product']}
        data-testid="td-product"
        data-anon={event.productId === undefined ? '' : undefined}
        title={event.productId}
      >
        {formatProductId(event.productId)}
      </span>
      <IdBadge id={event.requestId} testId="td-rid" title={`requestId: ${event.requestId}`} />
      <span class={s['tagAndSummary']}>
        <MethodTag kind={data.tagKind}>{data.displayTag}</MethodTag>
        <Latency text={untrack(() => props.latency)} />
        <Show when={waiting() !== undefined}>
          <span
            class={s['pending']}
            data-testid="td-pending"
            data-slow={(waiting() ?? 0) >= SLOW_AFTER_MS ? '' : undefined}
            data-pending-key={pendingKey ?? ''}
          >
            <PendingIcon size={10} />
            {`${context.work.formatPending(waiting() ?? 0)} pending`}
          </span>
        </Show>
        {data.summary !== '' ? (
          <span class={s['summary']} data-testid="td-summary">
            {data.summary}
          </span>
        ) : null}
      </span>
    </>
  );
}

function SystemCells(props: { event: StoredSystemEvent; latency: string | null }): JSX.Element {
  const data = toSystemRowData(untrack(() => props.event));
  return (
    <>
      <LayerBadge layer={data.layer} title={`source: ${data.source}`} />
      <IdBadge id={data.flowId} testId="td-rid" title={`flowId: ${data.flowId}`} />
      <span class={s['tagAndSummary']}>
        <MethodTag kind="system">{data.eventText}</MethodTag>
        <Latency text={untrack(() => props.latency)} />
        <span class={s['summary']} data-testid="td-summary">
          {data.summary}
        </span>
      </span>
    </>
  );
}
