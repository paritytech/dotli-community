// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// List view of the TrUAPI debug panel.
//
// Rows are keyed by event seq. The panel refreshes `events` at most once per
// animation frame, and keyed reconciliation keeps every row that is still
// visible as the same DOM node: new rows are appended, evicted ones removed.
// A browser drops a click whose target node is replaced between pointerdown
// and click, so rows must never be rebuilt under streaming traffic.

import {
  createEffect,
  createSignal,
  flush,
  For,
  Show,
  untrack,
} from "solid-js";
import type { JSX } from "@solidjs/web";
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
  rowClassName,
  systemRowData,
  truapiRowData,
} from "@dotli/truapi-debug";

import { createKeyedSignals, type KeyedSignals } from "./keyed-signals.js";

/** A pending badge counts up with the clock rather than with traffic, and a
 *  host that has stalled is precisely one that has stopped emitting events,
 *  so the store cannot be what wakes it. */
const PENDING_TICK_MS = 1000;

export interface Selection {
  seq: EventSeq;
  /** Correlation key of the selected event; its siblings are `paired`. */
  key: string | null;
}

/**
 * Per-row reactive inputs, shared by every row. Each is a map of per-key
 * signals, so a row subscribes to its own entries only: a click, an arrow key or a pending
 * call's clock re-runs the rows it changes, never all 2000 (one signal read
 * by every row is a HUGE_FAN_OUT at capacity).
 */
interface RowContext {
  /** The selected event, by seq. */
  selectedSeq: KeyedSignals<EventSeq, true>;
  /** The selected event's group, by correlation key. */
  selectedKey: KeyedSignals<string, true>;
  /** How long each call still waiting on a reply has waited, in ms, by
   *  pending key. Absent once the reply lands. */
  waiting: KeyedSignals<string, number>;
}

export function EventList(props: {
  /** The filtered events, in seq order. */
  events: readonly StoredEvent[];
  /** Every retained event: a reply outside the filter still closes a call. */
  allEvents: readonly StoredEvent[];
  /** When `allEvents` was read from the store. */
  refreshedAt: number;
  store: EventStore;
  selection: Selection | null;
  active: boolean;
  /** A collapsed panel shows no rows, so the badges stand still. */
  collapsed: boolean;
  onSelect: (seq: EventSeq) => void;
  listRef: (el: HTMLDivElement) => void;
}): JSX.Element {
  let list: HTMLDivElement | undefined;

  // Writes happen in effect functions, never in a compute. Only the entries
  // that flip are written, so only their rows re-run.
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

  // The badge clock. Ticks only while the rows are on screen, and renders
  // only while a call is pending.
  const tracker = new OpenCallTracker();
  const [tickedAt, setTickedAt] = createSignal(0);
  createEffect(
    () => props.active && !props.collapsed,
    (live) => {
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

  // Traffic writes only the calls it opened or closed; the tick, or coming
  // back on screen, rewrites every badge once.
  const waiting = createKeyedSignals<string, number>();
  let clockAt = 0;
  let wasLive = false;
  createEffect(
    () =>
      props.active && !props.collapsed
        ? {
            events: props.allEvents,
            // The latest clock reading: the refresh that brought the rows,
            // or the tick.
            tick: tickedAt(),
            now: Math.max(props.refreshedAt, tickedAt()),
          }
        : null,
    (input) => {
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
    list?.querySelector<HTMLElement>(`.td-row[data-seq="${String(seq)}"]`) ??
    null;

  return (
    <div
      class={props.active ? "td-list" : "td-list hidden"}
      role="list"
      tabindex="0"
      ref={(el) => {
        list = el;
        props.listRef(el);
      }}
      onClick={(e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>(".td-row");
        const seqAttr = row?.dataset["seq"];
        if (seqAttr === undefined) {
          return;
        }
        // Move focus to the list so keyboard navigation picks up immediately
        // after a click. Without this, arrow keys would scroll the page
        // instead of stepping through rows.
        list?.focus({ preventScroll: true });
        props.onSelect(Number(seqAttr));
      }}
      onKeyDown={(e) => {
        // Only while the list itself has focus (tabindex=0), so typing in the
        // filter inputs and browser shortcuts are left alone.
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") {
          return;
        }
        const seqs = props.events.map((ev) => ev.seq);
        if (seqs.length === 0) {
          return;
        }
        e.preventDefault();
        const selected = props.selection;
        const currentIdx = selected === null ? -1 : seqs.indexOf(selected.seq);
        let nextIdx: number;
        if (e.key === "ArrowDown") {
          // From nothing, the first row; otherwise the next, clamped to the last.
          nextIdx =
            currentIdx < 0 ? 0 : Math.min(currentIdx + 1, seqs.length - 1);
        } else {
          // From nothing, the last row; otherwise the previous, clamped to the first.
          nextIdx =
            currentIdx < 0 ? seqs.length - 1 : Math.max(currentIdx - 1, 0);
        }
        if (nextIdx === currentIdx) {
          return;
        }
        props.onSelect(seqs[nextIdx]);
        rowFor(seqs[nextIdx])?.scrollIntoView({ block: "nearest" });
      }}
    >
      <For
        each={props.events}
        keyed={(ev) => ev.seq}
        fallback={
          <div class="td-empty">No events match the current filter.</div>
        }
      >
        {(ev) => renderRow(untrack(ev), props.store, ctx)}
      </For>
    </div>
  );
}

/**
 * One list row. Stored events never change and rows are keyed by seq, so the
 * event is read once, at creation.
 *
 * A render helper rather than a component: in dev builds every component
 * instance gets its own refresh wrapper, and the list would then track one
 * source per row (a HUGE_FAN_IN diagnostic at the 2000-event capacity).
 */
function renderRow(
  ev: StoredEvent,
  store: EventStore,
  ctx: RowContext,
): JSX.Element {
  const key = correlationKeyOf(ev);
  // Measured against the group's first event as it stood at insert time, so
  // a row drawn after that event was evicted shows the same latency.
  const anchor = store.anchorOf(ev);
  const latency =
    anchor !== undefined
      ? `+${formatLatency(ev.receivedAt - anchor.receivedAt)}`
      : null;

  const rowClass = (): string => {
    const isSelected = ctx.selectedSeq.read(ev.seq) === true;
    const isPaired = !isSelected && ctx.selectedKey.read(key) === true;
    return rowClassName(isSelected, isPaired, ev.kind === "system");
  };

  return (
    <div
      class={rowClass()}
      data-seq={String(ev.seq)}
      data-rid={key}
      role="listitem"
    >
      <span class="td-time">{formatTime(ev.receivedAt)}</span>
      {ev.kind === "truapi" ? (
        <TruapiCells event={ev} latency={latency} ctx={ctx} />
      ) : (
        <SystemCells event={ev} latency={latency} />
      )}
    </div>
  );
}

function Latency(props: { text: string | null }): JSX.Element {
  return (
    <Show when={props.text}>
      {(text) => (
        <>
          {" "}
          <span class="td-latency">{text()}</span>
        </>
      )}
    </Show>
  );
}

function TruapiCells(props: {
  event: StoredTruapiEvent;
  latency: string | null;
  ctx: RowContext;
}): JSX.Element {
  const ev = untrack(() => props.event);
  const ctx = untrack(() => props.ctx);
  const data = truapiRowData(ev, pendingKeyOf(ev));
  const pendingKey = data.pendingKey;
  /** Reads this row's own entry only. */
  const waiting = (): number | undefined =>
    pendingKey === null ? undefined : ctx.waiting.read(pendingKey);

  return (
    <>
      {data.direction === "outgoing" ? (
        <span class="td-arrow-out">▶</span>
      ) : (
        <span class="td-arrow-in">◀</span>
      )}
      {data.productId === undefined ? (
        <span class="td-product anon">(no id)</span>
      ) : (
        <span class="td-product" title={data.productId}>
          {data.productId}
        </span>
      )}
      <span
        class="td-rid"
        style={{ color: data.ridColor }}
        title={`requestId: ${data.requestId}`}
      >
        {data.ridShort}
      </span>
      <span class="td-tag-and-summary">
        <span class={data.tagClassName}>{data.displayTag}</span>
        <Latency text={untrack(() => props.latency)} />
        {/* Present until the reply lands, counting up on the clock. */}
        <Show when={waiting() !== undefined}>
          <span
            class={
              (waiting() ?? 0) >= SLOW_AFTER_MS
                ? "td-pending slow"
                : "td-pending"
            }
            data-pending-key={pendingKey ?? ""}
          >
            {`⟳ ${formatPending(waiting() ?? 0)} pending`}
          </span>
        </Show>
        {data.summary !== "" ? (
          <span class="td-summary">{data.summary}</span>
        ) : null}
      </span>
    </>
  );
}

function SystemCells(props: {
  event: StoredSystemEvent;
  latency: string | null;
}): JSX.Element {
  const data = systemRowData(untrack(() => props.event));
  return (
    <>
      <span
        class={`td-layer-badge td-layer-${data.layer}`}
        title={`source: ${data.source}`}
      >
        {data.layer}
      </span>
      <span
        class="td-rid"
        style={{ color: data.ridColor }}
        title={`flowId: ${data.flowId}`}
      >
        {data.flowIdShort}
      </span>
      <span class="td-tag-and-summary">
        <span class="td-tag td-tag-sys">{data.eventText}</span>
        <Latency text={untrack(() => props.latency)} />
        <span class="td-summary">{data.summary}</span>
      </span>
    </>
  );
}
