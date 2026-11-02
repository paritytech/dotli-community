// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Rebuilt only when `revision` changes, never on traffic, which would close an open explanation and drop
// clicks. It renders a snapshot taken untracked, so the components below read nothing reactive.

import { createMemo, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { EventStore } from './model/createEventStore.js';
import { getCorrelationKey } from './model/getCorrelationKey.js';
import type { EventSeq, StoredEvent } from './model/storedEvent.js';
import { GroupDetail } from './detail/GroupDetail.js';
import { SingleDetail } from './detail/SingleDetail.js';
import type { PanelView } from './ViewTabs.js';
import { EmptyState } from './shared/EmptyState.js';
import { Pane } from './shared/Pane.js';

/** One event's detail, or its whole group's. */
type DetailKind = 'single' | 'group';

type Content =
  | { kind: 'empty'; message: string }
  | {
      kind: DetailKind;
      event: StoredEvent;
      group: StoredEvent[];
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
  hidden: boolean;
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
  function selectPair(seq: EventSeq): void {
    props.onSelectPair(seq);
  }

  function renderDetail(detail: Snapshot): JSX.Element {
    switch (detail.kind) {
      case 'empty':
        return <EmptyState testId="td-detail-empty">{detail.message}</EmptyState>;
      case 'group':
        return <GroupDetail event={detail.event} group={detail.group} first={detail.first} />;
      case 'single':
        return (
          <SingleDetail event={detail.event} group={detail.group} first={detail.first} onSelectPair={selectPair} />
        );
    }
  }

  return (
    <Pane testId="td-detail" label="Event detail" hidden={props.hidden} padded>
      {renderDetail(snapshot())}
    </Pane>
  );
}

function readContent({ store, selectedSeq, view }: Params): Content {
  if (selectedSeq === null) {
    return { kind: 'empty', message: 'Select an event on the left to inspect its payload.' };
  }
  const event = store.getBySeq(selectedSeq);
  if (event === undefined) {
    return { kind: 'empty', message: 'Selected event was evicted from the ring buffer.' };
  }
  const key = getCorrelationKey(event);
  return {
    kind: getDetailKind(view),
    event,
    group: store.eventsInGroup(key),
    first: store.firstInGroup(key),
  };
}

function getDetailKind(view: PanelView): DetailKind {
  switch (view) {
    case 'list':
      return 'single';
    case 'timeline':
      return 'group';
  }
}
