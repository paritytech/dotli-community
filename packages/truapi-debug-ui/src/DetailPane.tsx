// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Rebuilt only when `revision` changes, never on traffic, which would close an open explanation and drop
// clicks. It renders a snapshot taken untracked, so the components below read nothing reactive but the group, which
// follows traffic in place: its count and members grow as the list's highlight does, adding nodes and rebuilding none.

import { createEffect, createMemo, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { EventStore } from './model/createEventStore.js';
import { getCorrelationKey } from './model/getCorrelationKey.js';
import type { EventSeq, StoredEvent } from './model/storedEvent.js';
import { GroupDetail } from './detail/GroupDetail.js';
import { SingleDetail } from './detail/SingleDetail.js';
import type { PanelView } from './ViewTabs.js';
import { Callout } from './shared/Callout.js';
import { EmptyState } from './shared/EmptyState.js';
import { Pane } from './shared/Pane.js';
import s from './DetailPane.module.css';

/** One event's detail, or its whole group's. */
type DetailKind = 'single' | 'group';

type Content =
  | { kind: 'empty'; message: string }
  | {
      kind: DetailKind;
      event: StoredEvent;
      key: string;
      first: StoredEvent | undefined;
    };

type Snapshot = Content & { revision: number };

type Params = {
  store: EventStore;
  selectedSeq: EventSeq | null;
  view: PanelView;
};

export function DetailPane(props: {
  revision: number;
  selectedSeq: EventSeq | null;
  view: PanelView;
  store: EventStore;
  /** The panel's copy of the store, from which the shown group follows traffic. */
  events: readonly StoredEvent[];
  hidden: boolean;
  /** The filters hide the selected event from the list, though it still shows here. */
  filteredOut: boolean;
  onSelectPair: (seq: EventSeq) => void;
}): JSX.Element {
  // The revision is kept in the snapshot because a minifier drops an unused property read, and with it the dependency.
  const snapshot = createMemo((): Snapshot => {
    const revision = props.revision;
    return {
      revision,
      ...untrack(() => readContent({ store: props.store, selectedSeq: props.selectedSeq, view: props.view })),
    };
  });
  // The same array while the group is unchanged, so a frame that brings it nothing redraws nothing.
  const group = createMemo((previous: StoredEvent[] = []): StoredEvent[] => {
    const detail = snapshot();
    if (detail.kind === 'empty') {
      return previous.length === 0 ? previous : [];
    }
    const next = props.events.filter(e => getCorrelationKey(e) === detail.key);
    return isSameGroup(previous, next) ? previous : next;
  });
  let pane: HTMLDivElement | undefined;
  // Each new detail opens at its top, not where the last one was scrolled to.
  createEffect(snapshot, () => {
    if (pane !== undefined) {
      pane.scrollTop = 0;
    }
  });
  function selectPair(seq: EventSeq): void {
    props.onSelectPair(seq);
  }

  function renderDetail(detail: Snapshot): JSX.Element {
    switch (detail.kind) {
      case 'empty':
        return <EmptyState testId="td-detail-empty">{detail.message}</EmptyState>;
      case 'group':
        return <GroupDetail event={detail.event} group={group()} first={detail.first} />;
      case 'single':
        return <SingleDetail event={detail.event} group={group()} first={detail.first} onSelectPair={selectPair} />;
    }
  }

  return (
    <Pane
      testId="td-detail"
      label="Event detail"
      hidden={props.hidden}
      padded
      ref={element => {
        pane = element;
      }}
    >
      <Show when={props.filteredOut && snapshot().kind !== 'empty'}>
        <Callout testId="td-detail-filtered" tone="warn" class={s['filtered']}>
          Hidden by the current filter.
        </Callout>
      </Show>
      {renderDetail(snapshot())}
    </Pane>
  );
}

function readContent({ store, selectedSeq, view }: Params): Content {
  if (selectedSeq === null) {
    return { kind: 'empty', message: 'Select an event to inspect its payload.' };
  }
  const event = store.getBySeq(selectedSeq);
  if (event === undefined) {
    return { kind: 'empty', message: 'Selected event was evicted from the ring buffer.' };
  }
  const key = getCorrelationKey(event);
  return {
    kind: getDetailKind(view),
    event,
    key,
    first: store.firstInGroup(key),
  };
}

/** A group only gains events at its end and loses them at its start, so its ends and size tell a change. */
function isSameGroup(previous: readonly StoredEvent[], next: readonly StoredEvent[]): boolean {
  return previous.length === next.length && previous[0] === next[0] && previous.at(-1) === next.at(-1);
}

function getDetailKind(view: PanelView): DetailKind {
  switch (view) {
    case 'list':
      return 'single';
    case 'timeline':
      return 'group';
  }
}
