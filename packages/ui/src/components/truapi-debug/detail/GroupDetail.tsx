// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Timeline-view detail: every member of the clicked box's requestId or
// flowId group, stacked chronologically, each with its decoded chain
// annotations (if any) and its payload. All the members show together, so
// there are no pills: clicking a box means "show me the whole handshake",
// not "pick one message".

import { For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import {
  chainDetail,
  correlationKeyOf,
  eventCountLabel,
  formatTime,
  groupDuration,
  memberDelta,
  summariseSystemEvent,
  tagKind,
  type StoredEvent,
  type StoredSystemEvent,
  type StoredTruapiEvent,
} from '@dotli/truapi-debug';
import { Explanation } from './Explanation.js';
import { Field, Fields, IdValue } from './Fields.js';
import { ChainFields, ChainSummary, Payload, Summary } from './Sections.js';
import s from './GroupDetail.module.css';

export function GroupDetail(props: {
  event: StoredEvent;
  /** The event's group, in arrival order. */
  group: StoredEvent[];
  first: StoredEvent | undefined;
}): JSX.Element {
  const ev = untrack(() => props.event);
  const duration = untrack(() => groupDuration(props.first, props.group));
  return (
    <>
      <Fields testId="td-detail-head">
        {ev.kind === 'truapi' ? (
          <>
            <Field name="requestId">
              <IdValue id={correlationKeyOf(ev)} />
            </Field>
            <Field name="product">{ev.productId ?? '(no id)'}</Field>
          </>
        ) : (
          <>
            <Field name="flowId">
              <IdValue id={correlationKeyOf(ev)} />
            </Field>
            <Field name="source">{ev.source}</Field>
            <Field name="layer">{ev.layer}</Field>
          </>
        )}
        <Field name="group">{eventCountLabel(props.group.length)}</Field>
        <Show when={duration}>{d => <Field name="duration">{d()}</Field>}</Show>
      </Fields>
      <For each={props.group}>
        {m => {
          const delta = memberDelta(m, props.first);
          return m.kind === 'truapi' ? (
            <TruapiMember member={m} delta={delta} />
          ) : (
            <SystemMember member={m} delta={delta} />
          );
        }}
      </For>
    </>
  );
}

function TruapiMember(props: { member: StoredTruapiEvent; delta: string | null }): JSX.Element {
  const m = untrack(() => props.member);
  const chain = chainDetail(m.tag, m.payload);
  return (
    <div class={s['member']} data-testid="td-detail-member" data-seq={String(m.seq)}>
      <div class={s['header']}>
        <span class={s['time']} data-testid="td-time">
          {formatTime(m.receivedAt)}
        </span>
        {m.direction === 'outgoing' ? (
          <span class={s['arrowOut']} data-testid="td-arrow-out">
            ▶
          </span>
        ) : (
          <span class={s['arrowIn']} data-testid="td-arrow-in">
            ◀
          </span>
        )}
        <span class={s['tag']} data-testid="td-tag" data-kind={tagKind(m.tag)}>
          {m.tag}
        </span>
        <Delta text={props.delta} />
      </div>
      <ChainSummary chain={chain} />
      <ChainFields chain={chain} />
      <Payload payload={m.payload} />
    </div>
  );
}

function SystemMember(props: { member: StoredSystemEvent; delta: string | null }): JSX.Element {
  const m = untrack(() => props.member);
  return (
    <div class={s['member']} data-testid="td-detail-member" data-seq={String(m.seq)}>
      <div class={s['header']}>
        <span class={s['time']} data-testid="td-time">
          {formatTime(m.receivedAt)}
        </span>
        <span class={s['layer']} data-testid="td-layer-badge" data-layer={m.layer}>
          {m.layer}
        </span>
        <span class={s['tag']} data-testid="td-tag" data-kind="system">
          {m.event}
        </span>
        <Delta text={props.delta} />
      </div>
      <Summary text={summariseSystemEvent(m)} />
      <Explanation event={m} />
      <Payload payload={m.payload} />
    </div>
  );
}

function Delta(props: { text: string | null }): JSX.Element {
  return (
    <Show when={props.text}>
      {text => (
        <span class={s['latency']} data-testid="td-latency">
          {text()}
        </span>
      )}
    </Show>
  );
}
