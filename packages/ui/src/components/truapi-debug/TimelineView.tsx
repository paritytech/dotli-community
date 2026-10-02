// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Timeline view of the TrUAPI debug panel.
//
// Owns the scrolling container and decides when to redraw: whenever the
// filtered events change while the view is on screen. `Timeline` draws the
// swimlanes from the geometry `buildTimeline` makes, keyed so a redraw
// updates the nodes already there. The selection is reactive, so a click
// redraws nothing.

import { createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { buildTimeline, type EventSeq, type StoredEvent, type TimelineLane } from '@dotli/truapi-debug';
import { wireHoverTooltips } from './hover-tooltip.js';
import { Timeline } from './timeline/Timeline.js';
import s from './TimelineView.module.css';

export function TimelineView(props: {
  active: boolean;
  /** The filtered events. A new array redraws the timeline while active. */
  events: readonly StoredEvent[];
  selectedSeq: EventSeq | null;
  tooltip: () => HTMLElement | undefined;
  panel: () => HTMLElement | undefined;
  onSelect: (seq: EventSeq) => void;
}): JSX.Element {
  const [lanes, setLanes] = createSignal<readonly TimelineLane[]>([], {
    // Written from the redraw effect below.
    ownedWrite: true,
  });

  // Redrawn while visible whenever the filtered events change. The panel
  // hands over the same array when a refresh changed nothing visible (and
  // takes no refresh while collapsed), so such a frame lays nothing out.
  createEffect(
    () => (props.active ? props.events : null),
    events => {
      if (events !== null) {
        setLanes(buildTimeline(events));
      }
    },
  );

  let container: HTMLDivElement | undefined;
  const select = (seq: EventSeq, el: Element): void => {
    container?.focus({ preventScroll: true });
    props.onSelect(seq);
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  let unwireTooltips: (() => void) | undefined;
  onCleanup(() => {
    unwireTooltips?.();
  });

  return (
    <div
      class={s['timeline']}
      data-testid="td-timeline"
      tabindex="0"
      hidden={!props.active}
      ref={el => {
        container = el;
        unwireTooltips = wireHoverTooltips(
          el,
          untrack(() => props.tooltip),
          untrack(() => props.panel),
        );
      }}
    >
      <Timeline lanes={lanes()} selectedSeq={props.selectedSeq} onSelect={select} />
    </div>
  );
}
