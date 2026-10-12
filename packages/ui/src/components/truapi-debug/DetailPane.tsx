// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Rebuilt only when `revision` changes, never on traffic, which would close an open explanation and drop
// clicks. It renders a snapshot taken untracked, so the components below read nothing reactive.

import { createMemo, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { correlationKeyOf, type EventSeq, type EventStore, type StoredEvent } from '@dotli/truapi-debug';
import { GroupDetail } from './detail/GroupDetail.js';
import { SingleDetail } from './detail/SingleDetail.js';
import type { PanelView } from './ViewTabs.js';
import { EmptyState } from './shared/EmptyState.js';
import { Pane } from './shared/Pane.js';

type Content =
  | { kind: 'empty'; message: string }
  | {
      kind: 'single' | 'group';
      event: StoredEvent;
      group: StoredEvent[];
      first: StoredEvent | undefined;
    };

type Snapshot = Content & { revision: number };

function contentOf(store: EventStore, selectedSeq: EventSeq | null, view: PanelView): Content {
  if (selectedSeq === null) {
    return { kind: 'empty', message: 'Select an event on the left to inspect its payload.' };
  }
  const event = store.getBySeq(selectedSeq);
  if (event === undefined) {
    return { kind: 'empty', message: 'Selected event was evicted from the ring buffer.' };
  }
  const key = correlationKeyOf(event);
  return {
    kind: view === 'timeline' ? 'group' : 'single',
    event,
    group: store.eventsInGroup(key),
    first: store.firstInGroup(key),
  };
}

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
    return { revision, ...untrack(() => contentOf(props.store, props.selectedSeq, props.view)) };
  });
  const selectPair = (seq: EventSeq): void => {
    props.onSelectPair(seq);
  };

  const render = (snap: Snapshot): JSX.Element => {
    switch (snap.kind) {
      case 'empty':
        return <EmptyState testId="td-detail-empty">{snap.message}</EmptyState>;
      case 'group':
        return <GroupDetail event={snap.event} group={snap.group} first={snap.first} />;
      case 'single':
        return <SingleDetail event={snap.event} group={snap.group} first={snap.first} onSelectPair={selectPair} />;
    }
  };

  return (
    <Pane testId="td-detail" hidden={props.hidden} padded>
      {render(snapshot())}
    </Pane>
  );
}
