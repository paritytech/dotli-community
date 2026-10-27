// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { EventSeq, StoredEvent } from './model/storedEvent.js';
import type { TimelineLane } from './model/buildTimeline.js';
import { wireHoverTooltips } from './shared/wireHoverTooltips.js';
import { Pane } from './shared/Pane.js';
import { Timeline } from './timeline/Timeline.js';
import { usePanelWork } from './panelWork.js';

export function TimelineView(props: {
  active: boolean;
  /** A new array redraws the timeline while active. */
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

  const { buildTimeline } = usePanelWork();
  createEffect(
    () => (props.active ? props.events : null),
    events => {
      if (events !== null) {
        setLanes(buildTimeline(events));
      }
    },
  );

  let container: HTMLDivElement | undefined;
  function select(seq: EventSeq, element: Element): void {
    container?.focus({ preventScroll: true });
    props.onSelect(seq);
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  let disposeTooltips: (() => void) | undefined;
  onCleanup(() => {
    disposeTooltips?.();
  });

  return (
    <Pane
      testId="td-timeline"
      label="Timeline"
      hidden={!props.active}
      ownFocus
      ref={element => {
        container = element;
        disposeTooltips = wireHoverTooltips({
          root: element,
          tooltip: untrack(() => props.tooltip),
          panel: untrack(() => props.panel),
        });
      }}
    >
      <Timeline lanes={lanes()} selectedSeq={props.selectedSeq} onSelect={select} />
    </Pane>
  );
}
