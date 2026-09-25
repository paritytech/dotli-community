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
  createMemo,
  createSignal,
  flush,
  For,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import { formatLatency, formatTime } from "@dotli/truapi-debug/detail-html";
import {
  correlationKeyOf,
  type EventSeq,
  type EventStore,
  type StoredEvent,
  type StoredSystemEvent,
  type StoredTruapiEvent,
} from "@dotli/truapi-debug/event-store";
import {
  formatPending,
  openCalls,
  pendingKeyOf,
  SLOW_AFTER_MS,
} from "@dotli/truapi-debug/pending";
import { systemRowData, truapiRowData } from "@dotli/truapi-debug/row-format";

/** A pending badge counts up with the clock rather than with traffic, and a
 *  host that has stalled is precisely one that has stopped emitting events,
 *  so the store cannot be what wakes it. */
const PENDING_TICK_MS = 1000;

export interface Selection {
  seq: EventSeq;
  /** Correlation key of the selected event; its siblings are `paired`. */
  key: string | null;
}

/** Per-row reactive inputs, shared by every row. */
interface RowContext {
  selection: () => Selection | null;
  /** Calls still waiting on a reply, keyed by pending key. */
  open: () => Map<string, number>;
  now: () => number;
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
  onSelect: (seq: EventSeq) => void;
  listRef: (el: HTMLDivElement) => void;
}): JSX.Element {
  let list: HTMLDivElement | undefined;

  const [tickedAt, setTickedAt] = createSignal(0);
  const pendingTick = setInterval(() => {
    if (props.active) {
      flush(() => setTickedAt(Date.now()));
    }
  }, PENDING_TICK_MS);
  onCleanup(() => {
    clearInterval(pendingTick);
  });

  const open = createMemo(() => openCalls(props.allEvents));
  const ctx: RowContext = {
    selection: () => props.selection,
    open,
    // The latest clock reading: the refresh that brought the rows, or the tick.
    now: () => Math.max(props.refreshedAt, tickedAt()),
  };

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
        const seqAttr = row?.dataset.seq;
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
  const first = store.firstInGroup(key);
  const latency =
    first !== undefined && first.seq !== ev.seq
      ? `+${formatLatency(ev.receivedAt - first.receivedAt)}`
      : null;

  // Class order is part of the markup contract: td-row, selected, paired, system.
  const rowClass = (): string => {
    const selection = ctx.selection();
    const isSelected = selection?.seq === ev.seq;
    const isPaired = selection !== null && !isSelected && selection.key === key;
    return [
      "td-row",
      isSelected ? "selected" : "",
      isPaired ? "paired" : "",
      ev.kind === "system" ? "system" : "",
    ]
      .filter((c) => c !== "")
      .join(" ");
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
  const startedAt = (): number | undefined =>
    pendingKey === null ? undefined : ctx.open().get(pendingKey);

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
        <Show when={startedAt()}>
          {(since) => {
            const waiting = (): number => ctx.now() - since();
            return (
              <span
                class={
                  waiting() >= SLOW_AFTER_MS ? "td-pending slow" : "td-pending"
                }
                data-pending-key={pendingKey ?? ""}
              >
                {`⟳ ${formatPending(waiting())} pending`}
              </span>
            );
          }}
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
