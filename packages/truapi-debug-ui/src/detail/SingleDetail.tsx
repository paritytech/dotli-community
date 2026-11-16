// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { getChainDetail } from '../model/getChainDetail.js';
import { formatEventCount } from '../model/formatEventCount.js';
import { formatProductId } from '../model/formatProductId.js';
import { formatTime } from '../model/formatTime.js';
import { listSiblingPills } from '../model/listSiblingPills.js';
import { summariseSystemEvent } from '../model/summariseSystemEvent.js';
import type { EventSeq, StoredEvent, StoredSystemEvent, StoredTruapiEvent } from '../model/storedEvent.js';
import { Explanation } from './Explanation.js';
import { KeyValue, KeyValueList } from '../shared/KeyValueList.js';
import { IdBadge } from '../shared/IdBadge.js';
import { LinkButton } from '../shared/LinkButton.js';
import { SectionTitle } from '../shared/SectionTitle.js';
import { ChainFields, ChainSummary, Payload, Summary } from './Sections.js';
import s from './Sections.module.css';

type SingleDetailProps = {
  event: StoredEvent;
  /** Includes the event itself. Follows traffic, the only prop that changes. */
  group: StoredEvent[];
  first: StoredEvent | undefined;
  onSelectPair: (seq: EventSeq) => void;
};

export function SingleDetail(props: SingleDetailProps): JSX.Element {
  return <>{renderDetail(props)}</>;
}

function renderDetail(props: SingleDetailProps): JSX.Element {
  const event = untrack(() => props.event);
  switch (event.kind) {
    case 'truapi':
      return <TruapiDetail {...props} event={event} />;
    case 'system':
      return <SystemDetail {...props} event={event} />;
  }
}

function TruapiDetail(props: SingleDetailProps & { event: StoredTruapiEvent }): JSX.Element {
  const event = untrack(() => props.event);
  const chain = getChainDetail(event.tag, event.payload);
  return (
    <>
      <KeyValueList testId="td-detail-head" class={s['fields']}>
        <KeyValue name="time">{formatTime(event.receivedAt)}</KeyValue>
        <KeyValue name="direction">{event.direction}</KeyValue>
        <KeyValue name="product">{formatProductId(event.productId)}</KeyValue>
        <KeyValue name="tag">{event.tag}</KeyValue>
        <KeyValue name="requestId">
          <IdBadge id={event.requestId} testId="td-id-badge" />
        </KeyValue>
        <GroupField {...props} />
      </KeyValueList>
      <ChainSummary chain={chain} />
      <ChainFields chain={chain} />
      <Payload payload={event.payload} />
    </>
  );
}

function SystemDetail(props: SingleDetailProps & { event: StoredSystemEvent }): JSX.Element {
  const event = untrack(() => props.event);
  return (
    <>
      <KeyValueList testId="td-detail-head" class={s['fields']}>
        <KeyValue name="time">{formatTime(event.receivedAt)}</KeyValue>
        <KeyValue name="source">{event.source}</KeyValue>
        <KeyValue name="layer">{event.layer}</KeyValue>
        <KeyValue name="event">{event.event}</KeyValue>
        <KeyValue name="flowId">
          <IdBadge id={event.flowId} testId="td-id-badge" />
        </KeyValue>
        <GroupField {...props} />
      </KeyValueList>
      <SectionTitle>Summary</SectionTitle>
      <Summary text={summariseSystemEvent(event)} />
      <Explanation event={event} />
      <Payload payload={event.payload} />
    </>
  );
}

function GroupField(props: SingleDetailProps): JSX.Element {
  const event = untrack(() => props.event);
  const first = untrack(() => props.first);
  const pills = createMemo(() =>
    listSiblingPills({ event, first, siblings: props.group.filter(sibling => sibling.seq !== event.seq) }),
  );
  return (
    <KeyValue name="group">
      {formatEventCount(props.group.length)}
      <Show when={pills().length > 0}>
        {': '}
        <For each={pills()} keyed={pill => pill.seq}>
          {(pill, index) => (
            <>
              {index() > 0 ? ' · ' : ''}
              <LinkButton
                testId="td-detail-pair"
                value={String(pill().seq)}
                title={pill().title}
                onClick={() => {
                  props.onSelectPair(pill().seq);
                }}
              >
                {pill().label}
              </LinkButton>
            </>
          )}
        </For>
      </Show>
    </KeyValue>
  );
}
