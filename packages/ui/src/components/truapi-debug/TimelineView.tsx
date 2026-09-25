// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Timeline view of the TrUAPI debug panel.
//
// Drawn by `@dotli/truapi-debug/timeline`, which reconciles its SVG by key so
// hover state and in-flight clicks survive streaming traffic. This component
// owns the container and decides when to redraw; it never rebuilds the SVG
// itself. A click flips the selection in place rather than redrawing.

import { createEffect, onCleanup, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { EventSeq, StoredEvent } from "@dotli/truapi-debug/event-store";
import {
  applyTimelineSelection,
  buildTimelineContainer,
  renderSwimlanes,
  resolveTimelineClick,
} from "@dotli/truapi-debug/timeline";
import { wireHoverTooltips } from "./hover-tooltip";

export function TimelineView(props: {
  active: boolean;
  /** The filtered events. A new array redraws the timeline while active. */
  events: readonly StoredEvent[];
  selectedSeq: EventSeq | null;
  tooltip: () => HTMLElement | undefined;
  panel: () => HTMLElement | undefined;
  onSelect: (seq: EventSeq) => void;
}): JSX.Element {
  const { container } = buildTimelineContainer();

  createEffect(
    () => props.active,
    (active) => {
      container.classList.toggle("hidden", !active);
    },
  );

  // Redrawn on every refresh while visible, so pending segments grow toward
  // "now". The selection is read at draw time only: a click is applied in
  // place below, not by redrawing.
  createEffect(
    () => (props.active ? props.events : null),
    (events) => {
      if (events !== null) {
        renderSwimlanes(
          container,
          events,
          untrack(() => props.selectedSeq),
        );
      }
    },
  );

  const onClick = (e: MouseEvent): void => {
    const seq = resolveTimelineClick(e.target);
    if (seq === null) {
      return;
    }
    container.focus({ preventScroll: true });
    applyTimelineSelection(container, props.selectedSeq, seq);
    props.onSelect(seq);
  };
  container.addEventListener("click", onClick);
  const unwireTooltips = wireHoverTooltips(
    container,
    untrack(() => props.tooltip),
    untrack(() => props.panel),
  );
  onCleanup(() => {
    container.removeEventListener("click", onClick);
    unwireTooltips();
  });

  return container;
}
