// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import {
  chainDetail,
  eventCountLabel,
  formatTime,
  siblingPills,
  summariseSystemEvent,
  type EventSeq,
  type StoredEvent,
  type StoredSystemEvent,
  type StoredTruapiEvent,
} from '@dotli/truapi-debug';
import { Explanation } from './Explanation.js';
import { KeyValue, KeyValueList } from '../shared/KeyValueList.js';
import { IdValue } from '../shared/IdBadge.js';
import { SectionTitle } from '../shared/SectionTitle.js';
import { ChainFields, ChainSummary, Payload, Summary } from './Sections.js';
import s from './SingleDetail.module.css';

interface SingleDetailProps {
  event: StoredEvent;
  /** Includes the event itself. */
  group: StoredEvent[];
  first: StoredEvent | undefined;
  onSelectPair: (seq: EventSeq) => void;
}

export function SingleDetail(props: SingleDetailProps): JSX.Element {
  const ev = untrack(() => props.event);
  return <>{ev.kind === 'truapi' ? <TruapiDetail {...props} event={ev} /> : <SystemDetail {...props} event={ev} />}</>;
}

function TruapiDetail(props: SingleDetailProps & { event: StoredTruapiEvent }): JSX.Element {
  const ev = untrack(() => props.event);
  const chain = chainDetail(ev.tag, ev.payload);
  return (
    <>
      <KeyValueList testId="td-detail-head">
        <KeyValue name="time">{formatTime(ev.receivedAt)}</KeyValue>
        <KeyValue name="direction">{ev.direction}</KeyValue>
        <KeyValue name="product">{ev.productId ?? '(no id)'}</KeyValue>
        <KeyValue name="tag">{ev.tag}</KeyValue>
        <KeyValue name="requestId">
          <IdValue id={ev.requestId} />
        </KeyValue>
        <GroupField {...props} />
      </KeyValueList>
      <ChainSummary chain={chain} />
      <ChainFields chain={chain} />
      <Payload payload={ev.payload} />
    </>
  );
}

function SystemDetail(props: SingleDetailProps & { event: StoredSystemEvent }): JSX.Element {
  const ev = untrack(() => props.event);
  return (
    <>
      <KeyValueList testId="td-detail-head">
        <KeyValue name="time">{formatTime(ev.receivedAt)}</KeyValue>
        <KeyValue name="source">{ev.source}</KeyValue>
        <KeyValue name="layer">{ev.layer}</KeyValue>
        <KeyValue name="event">{ev.event}</KeyValue>
        <KeyValue name="flowId">
          <IdValue id={ev.flowId} />
        </KeyValue>
        <GroupField {...props} />
      </KeyValueList>
      <SectionTitle>Summary</SectionTitle>
      <Summary text={summariseSystemEvent(ev)} />
      <Explanation event={ev} />
      <Payload payload={ev.payload} />
    </>
  );
}

function GroupField(props: SingleDetailProps): JSX.Element {
  const pills = untrack(() =>
    siblingPills(
      props.event,
      props.first,
      props.group.filter(g => g.seq !== props.event.seq),
    ),
  );
  return (
    <KeyValue name="group">
      {eventCountLabel(props.group.length)}
      <Show when={pills.length > 0}>
        {' — '}
        <For each={pills}>
          {(pill, i) => (
            <>
              {i() > 0 ? ' · ' : ''}
              <span
                class={s['pair']}
                data-testid="td-detail-pair"
                data-seq={String(pill.seq)}
                title={pill.title}
                onClick={() => {
                  props.onSelectPair(pill.seq);
                }}
              >
                {pill.label}
              </span>
            </>
          )}
        </For>
      </Show>
    </KeyValue>
  );
}
