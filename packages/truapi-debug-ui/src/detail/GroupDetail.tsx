// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Clicking a timeline box asks for the whole handshake, so every member shows together and there are no pills.

import { For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import {
  chainDetail,
  correlationKeyOf,
  eventCountLabel,
  groupDuration,
  memberDelta,
  summariseSystemEvent,
  tagKind,
  type StoredEvent,
  type StoredSystemEvent,
  type StoredTruapiEvent,
} from '@dotli/truapi-debug';
import { Explanation } from './Explanation.js';
import { KeyValue, KeyValueList } from '../shared/KeyValueList.js';
import { IdValue } from '../shared/IdBadge.js';
import { DirectionArrow } from '../shared/DirectionArrow.js';
import { Inline } from '../shared/Inline.js';
import { Latency } from '../shared/Latency.js';
import { LayerBadge } from '../shared/LayerBadge.js';
import { MethodTag } from '../shared/MethodTag.js';
import { Stack } from '../shared/Stack.js';
import { Timestamp } from '../shared/Timestamp.js';
import { ChainFields, ChainSummary, Payload, Summary } from './Sections.js';
import s from './GroupDetail.module.css';

export function GroupDetail(props: {
  event: StoredEvent;
  group: StoredEvent[];
  first: StoredEvent | undefined;
}): JSX.Element {
  const ev = untrack(() => props.event);
  const duration = untrack(() => groupDuration(props.first, props.group));
  return (
    <>
      <KeyValueList testId="td-detail-head">
        {ev.kind === 'truapi' ? (
          <>
            <KeyValue name="requestId">
              <IdValue id={correlationKeyOf(ev)} />
            </KeyValue>
            <KeyValue name="product">{ev.productId ?? '(no id)'}</KeyValue>
          </>
        ) : (
          <>
            <KeyValue name="flowId">
              <IdValue id={correlationKeyOf(ev)} />
            </KeyValue>
            <KeyValue name="source">{ev.source}</KeyValue>
            <KeyValue name="layer">{ev.layer}</KeyValue>
          </>
        )}
        <KeyValue name="group">{eventCountLabel(props.group.length)}</KeyValue>
        <Show when={duration}>{d => <KeyValue name="duration">{d()}</KeyValue>}</Show>
      </KeyValueList>
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
      <Stack stretch>
        <Inline>
          <Timestamp at={m.receivedAt} />
          <DirectionArrow direction={m.direction} />
          <MethodTag kind={tagKind(m.tag)}>{m.tag}</MethodTag>
          <Latency text={props.delta} />
        </Inline>
        <ChainSummary chain={chain} />
        <ChainFields chain={chain} />
        <Payload payload={m.payload} />
      </Stack>
    </div>
  );
}

function SystemMember(props: { member: StoredSystemEvent; delta: string | null }): JSX.Element {
  const m = untrack(() => props.member);
  return (
    <div class={s['member']} data-testid="td-detail-member" data-seq={String(m.seq)}>
      <Stack stretch>
        <Inline>
          <Timestamp at={m.receivedAt} />
          <LayerBadge layer={m.layer} />
          <MethodTag kind="system">{m.event}</MethodTag>
          <Latency text={props.delta} />
        </Inline>
        <Summary text={summariseSystemEvent(m)} />
        <Explanation event={m} />
        <Payload payload={m.payload} />
      </Stack>
    </div>
  );
}
