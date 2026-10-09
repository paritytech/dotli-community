// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Rows are keyed by seq and must never be rebuilt under streaming traffic, because a browser drops a click
// whose target node is replaced between pointerdown and click.

import { createEffect, createSignal, flush, For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import {
  formatLatency,
  formatTime,
  correlationKeyOf,
  type EventSeq,
  type EventStore,
  type StoredEvent,
  type StoredSystemEvent,
  type StoredTruapiEvent,
  formatPending,
  OpenCallTracker,
  pendingKeyOf,
  SLOW_AFTER_MS,
  rowSelection,
  systemRowData,
  truapiRowData,
} from '@dotli/truapi-debug';

import { createKeyedSignals, type KeyedSignals } from './keyed-signals.js';
import { IdBadge } from './shared/IdBadge.js';
import { itemClass, itemListClass } from './shared/ItemList.js';
import { Latency } from './shared/Latency.js';
import s from './EventList.module.css';

/** Pending badges tick on a clock, since a stalled host is exactly one that emits no events. */
const PENDING_TICK_MS = 1000;

export interface Selection {
  seq: EventSeq;
  /** Correlation key. Events sharing it are `paired`. */
  key: string | null;
}

/** Per-key signals, so a selection or clock change re-runs only the rows it touches, not all of them. */
interface RowContext {
  selectedSeq: KeyedSignals<EventSeq, true>;
  /** By correlation key. */
  selectedKey: KeyedSignals<string, true>;
  /** Ms waited by each call still open, by pending key. */
  waiting: KeyedSignals<string, number>;
}

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
  listRef: (el: HTMLDivElement) => void;
}): JSX.Element {
  let list: HTMLDivElement | undefined;

  // Written in effect functions, never in a compute.
  const selectedSeq = createKeyedSignals<EventSeq, true>();
  const selectedKey = createKeyedSignals<string, true>();
  createEffect(
    () => props.selection,
    (selection, prev = null) => {
      if (prev?.seq !== selection?.seq) {
        if (prev !== null) {
          selectedSeq.write(prev.seq, undefined);
        }
        if (selection !== null) {
          selectedSeq.write(selection.seq, true);
        }
      }
      const prevKey = prev?.key ?? null;
      const nextKey = selection?.key ?? null;
      if (prevKey !== nextKey) {
        if (prevKey !== null) {
          selectedKey.write(prevKey, undefined);
        }
        if (nextKey !== null) {
          selectedKey.write(nextKey, true);
        }
      }
    },
  );

  const tracker = new OpenCallTracker();
  const [tickedAt, setTickedAt] = createSignal(0);
  createEffect(
    () => props.active && !props.collapsed,
    live => {
      if (!live) {
        return;
      }
      const tick = setInterval(() => {
        if (tracker.open.size > 0) {
          flush(() => setTickedAt(Date.now()));
        }
      }, PENDING_TICK_MS);
      return () => {
        clearInterval(tick);
      };
    },
  );

  // Traffic writes only the calls it opened or closed. A tick, or coming back on screen, rewrites every badge.
  const waiting = createKeyedSignals<string, number>();
  let clockAt = 0;
  let wasLive = false;
  createEffect(
    () =>
      props.active && !props.collapsed
        ? {
            events: props.allEvents,
            tick: tickedAt(),
            now: Math.max(props.refreshedAt, tickedAt()),
          }
        : null,
    input => {
      if (input === null) {
        wasLive = false;
        return;
      }
      tracker.update(input.events);
      const open = tracker.open;
      if (!wasLive || input.tick !== clockAt) {
        wasLive = true;
        clockAt = input.tick;
        for (const key of [...waiting.keys()]) {
          if (!open.has(key)) {
            waiting.write(key, undefined);
          }
        }
        for (const [key, since] of open) {
          waiting.write(key, input.now - since);
        }
        return;
      }
      for (const key of tracker.changedKeys) {
        const since = open.get(key);
        waiting.write(key, since === undefined ? undefined : input.now - since);
      }
    },
  );

  const ctx: RowContext = { selectedSeq, selectedKey, waiting };

  const rowFor = (seq: EventSeq): HTMLElement | null =>
    list?.querySelector<HTMLElement>(`[data-seq="${String(seq)}"]`) ?? null;

  return (
    <div
      class={[itemListClass, s['list']]}
      data-testid="td-list"
      hidden={!props.active}
      role="list"
      tabindex="0"
      ref={el => {
        list = el;
        props.listRef(el);
      }}
      onClick={e => {
        const row = (e.target as HTMLElement).closest<HTMLElement>('[data-seq]');
        const seqAttr = row?.dataset['seq'];
        if (seqAttr === undefined) {
          return;
        }
        // Otherwise arrow keys after a click scroll the page instead of stepping rows.
        list?.focus({ preventScroll: true });
        props.onSelect(Number(seqAttr));
      }}
      onKeyDown={e => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
          return;
        }
        const events = props.events;
        if (events.length === 0) {
          return;
        }
        e.preventDefault();
        const selected = props.selection;
        const currentIdx = selected === null ? -1 : events.findIndex(ev => ev.seq === selected.seq);
        let nextIdx: number;
        if (e.key === 'ArrowDown') {
          nextIdx = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, events.length - 1);
        } else {
          nextIdx = currentIdx < 0 ? events.length - 1 : Math.max(currentIdx - 1, 0);
        }
        const nextSeq = events[nextIdx]?.seq;
        if (nextIdx === currentIdx || nextSeq === undefined) {
          return;
        }
        props.onSelect(nextSeq);
        rowFor(nextSeq)?.scrollIntoView({ block: 'nearest' });
      }}
    >
      <For
        each={props.events}
        keyed={ev => ev.seq}
        fallback={
          <div class={s['empty']} data-testid="td-empty">
            No events match the current filter.
          </div>
        }
      >
        {ev => renderRow(untrack(ev), props.store, ctx)}
      </For>
    </div>
  );
}

/**
 * One list row, reading its immutable event once.
 *
 * A helper, not a component, because dev builds wrap each component instance and the list would track one
 * source per row (HUGE_FAN_IN at capacity).
 */
function renderRow(ev: StoredEvent, store: EventStore, ctx: RowContext): JSX.Element {
  const key = correlationKeyOf(ev);
  // The anchor is captured at insert time, so a row drawn after the group head was evicted keeps its latency.
  const anchor = store.anchorOf(ev);
  const latency = anchor !== undefined ? `+${formatLatency(ev.receivedAt - anchor.receivedAt)}` : null;

  const selection = (): string | undefined =>
    rowSelection(ctx.selectedSeq.read(ev.seq) === true, ctx.selectedKey.read(key) === true);

  return (
    <div
      class={[itemClass, s['row']]}
      data-testid="td-row"
      data-selection={selection()}
      data-system={ev.kind === 'system' ? '' : undefined}
      data-seq={String(ev.seq)}
      role="listitem"
    >
      <span class={s['time']} data-testid="td-time">
        {formatTime(ev.receivedAt)}
      </span>
      {ev.kind === 'truapi' ? (
        <TruapiCells event={ev} latency={latency} ctx={ctx} />
      ) : (
        <SystemCells event={ev} latency={latency} />
      )}
    </div>
  );
}

function TruapiCells(props: { event: StoredTruapiEvent; latency: string | null; ctx: RowContext }): JSX.Element {
  const ev = untrack(() => props.event);
  const ctx = untrack(() => props.ctx);
  const data = truapiRowData(ev, pendingKeyOf(ev));
  const pendingKey = data.pendingKey;
  const waiting = (): number | undefined => (pendingKey === null ? undefined : ctx.waiting.read(pendingKey));

  return (
    <>
      {data.direction === 'outgoing' ? (
        <span class={s['arrowOut']} data-testid="td-arrow-out">
          ▶
        </span>
      ) : (
        <span class={s['arrowIn']} data-testid="td-arrow-in">
          ◀
        </span>
      )}
      {data.productId === undefined ? (
        <span class={s['product']} data-testid="td-product" data-anon="">
          (no id)
        </span>
      ) : (
        <span class={s['product']} data-testid="td-product" title={data.productId}>
          {data.productId}
        </span>
      )}
      <IdBadge id={data.requestId} testId="td-rid" title={`requestId: ${data.requestId}`} />
      <span class={s['tagAndSummary']}>
        <span class={s['tag']} data-testid="td-tag" data-kind={data.tagKind}>
          {data.displayTag}
        </span>
        <Latency text={untrack(() => props.latency)} />
        <Show when={waiting() !== undefined}>
          <span
            class={s['pending']}
            data-testid="td-pending"
            data-slow={(waiting() ?? 0) >= SLOW_AFTER_MS ? '' : undefined}
            data-pending-key={pendingKey ?? ''}
          >
            {`⟳ ${formatPending(waiting() ?? 0)} pending`}
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
  const data = systemRowData(untrack(() => props.event));
  return (
    <>
      <span class={s['layer']} data-testid="td-layer-badge" data-layer={data.layer} title={`source: ${data.source}`}>
        {data.layer}
      </span>
      <IdBadge id={data.flowId} testId="td-rid" title={`flowId: ${data.flowId}`} />
      <span class={s['tagAndSummary']}>
        <span class={s['tag']} data-testid="td-tag" data-kind="system">
          {data.eventText}
        </span>
        <Latency text={untrack(() => props.latency)} />
        <span class={s['summary']} data-testid="td-summary">
          {data.summary}
        </span>
      </span>
    </>
  );
}
