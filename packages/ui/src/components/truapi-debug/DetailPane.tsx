// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Detail pane of the TrUAPI debug panel.
//
// Rebuilt only when `revision` changes, which the panel bumps on user actions
// (selection, a filter change that hides or shows the selected event, tab
// swap, clear, mount). Incoming events never touch it: rebuilding under
// traffic tore down an open "What is this?" block and dropped clicks inside
// the pane between pointerdown and click.
//
// So the pane renders from a snapshot (the event, its group, the view) taken
// untracked when the revision changes. The components below it get plain
// values and read nothing reactive.

import { createMemo, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { correlationKeyOf, type EventSeq, type EventStore, type StoredEvent } from '@dotli/truapi-debug';
import { GroupDetail } from './detail/GroupDetail.js';
import { SingleDetail } from './detail/SingleDetail.js';
import type { PanelView } from './Tabs.js';
import s from './DetailPane.module.css';

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
  /** A full-width view (Resolution, Archive) is showing. */
  hidden: boolean;
  onSelectPair: (seq: EventSeq) => void;
}): JSX.Element {
  // The revision is the memo's one tracked read, so it alone decides when the
  // pane rebuilds. The snapshot keeps it: a minifier drops a property read
  // whose value goes unused, and with it the dependency.
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
        return (
          <div class={s['empty']} data-testid="td-detail-empty">
            {snap.message}
          </div>
        );
      case 'group':
        return <GroupDetail event={snap.event} group={snap.group} first={snap.first} />;
      case 'single':
        return <SingleDetail event={snap.event} group={snap.group} first={snap.first} onSelectPair={selectPair} />;
    }
  };

  return (
    <div class={s['detail']} data-testid="td-detail" hidden={props.hidden}>
      {render(snapshot())}
    </div>
  );
}
