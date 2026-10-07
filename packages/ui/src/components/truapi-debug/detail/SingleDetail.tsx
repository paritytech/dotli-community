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
import { Field, Fields, IdValue } from './Fields.js';
import { ChainFields, ChainSummary, Payload, SectionTitle, Summary } from './Sections.js';
import s from './SingleDetail.module.css';

interface SingleDetailProps {
  event: StoredEvent;
  /** The event's group, the event included. */
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
      <Fields testId="td-detail-head">
        <Field name="time">{formatTime(ev.receivedAt)}</Field>
        <Field name="direction">{ev.direction}</Field>
        <Field name="product">{ev.productId ?? '(no id)'}</Field>
        <Field name="tag">{ev.tag}</Field>
        <Field name="requestId">
          <IdValue id={ev.requestId} />
        </Field>
        <GroupField {...props} />
      </Fields>
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
      <Fields testId="td-detail-head">
        <Field name="time">{formatTime(ev.receivedAt)}</Field>
        <Field name="source">{ev.source}</Field>
        <Field name="layer">{ev.layer}</Field>
        <Field name="event">{ev.event}</Field>
        <Field name="flowId">
          <IdValue id={ev.flowId} />
        </Field>
        <GroupField {...props} />
      </Fields>
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
    <Field name="group">
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
    </Field>
  );
}
