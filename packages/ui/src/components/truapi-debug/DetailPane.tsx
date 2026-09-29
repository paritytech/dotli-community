// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Detail pane of the TrUAPI debug panel.
//
// Rebuilt only when `revision` changes, which the panel bumps on user actions
// (selection, a filter change that hides or shows the selected event, tab
// swap, clear, mount). Incoming events never
// touch it: rebuilding under traffic tore down an open "What is this?" block
// and dropped clicks inside the pane between pointerdown and click.

import { createEffect, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { renderGroupDetail, renderSingleDetail } from "@dotli/truapi-debug";
import type { EventSeq, EventStore } from "@dotli/truapi-debug";
import type { PanelView } from "./Tabs.js";

function detailHtml(
  store: EventStore,
  selectedSeq: EventSeq | null,
  view: PanelView,
): string {
  if (selectedSeq === null) {
    return `<div class="td-detail-empty">Select an event on the left to inspect its payload.</div>`;
  }
  const ev = store.getBySeq(selectedSeq);
  if (ev === undefined) {
    return `<div class="td-detail-empty">Selected event was evicted from the ring buffer.</div>`;
  }
  return view === "timeline"
    ? renderGroupDetail(ev, store)
    : renderSingleDetail(ev, store);
}

export function DetailPane(props: {
  /** Bumped by the panel whenever the pane must be rebuilt. */
  revision: number;
  selectedSeq: EventSeq | null;
  view: PanelView;
  store: EventStore;
  /** A sibling pill was clicked. */
  onSelectPair: (seq: EventSeq) => void;
}): JSX.Element {
  let pane: HTMLDivElement | undefined;

  createEffect(
    () => props.revision,
    () => {
      if (pane === undefined) {
        return;
      }
      // Read at rebuild time only: the revision alone decides when.
      const html = untrack(() =>
        detailHtml(props.store, props.selectedSeq, props.view),
      );
      // Every product and network value is escaped by detail-html.ts.
      pane.innerHTML = html;
    },
  );

  return (
    <div
      class="td-detail"
      ref={(el) => {
        pane = el;
      }}
      onClick={(e) => {
        const pair = (e.target as HTMLElement).closest<HTMLElement>(
          ".td-detail-pair",
        );
        const seqAttr = pair?.dataset["seq"];
        if (seqAttr !== undefined) {
          props.onSelectPair(Number(seqAttr));
        }
      }}
    />
  );
}
