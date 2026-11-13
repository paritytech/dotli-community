// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Clicking a timeline box asks for the whole handshake, so every member shows together and there are no pills.

import { For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { getChainDetail } from '../model/getChainDetail.js';
import { formatEventCount } from '../model/formatEventCount.js';
import { formatGroupDuration } from '../model/formatGroupDuration.js';
import { formatMemberDelta } from '../model/formatMemberDelta.js';
import { formatProductId } from '../model/formatProductId.js';
import type { StoredEvent, StoredSystemEvent, StoredTruapiEvent } from '../model/storedEvent.js';
import { summariseSystemEvent } from '../model/summariseSystemEvent.js';
import { getTagKind } from '../model/getTagKind.js';
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
  const event = untrack(() => props.event);
  const duration = untrack(() => formatGroupDuration(props.first, props.group));
  return (
    <>
      <KeyValueList testId="td-detail-head">
        {renderHeadFields(event)}
        <KeyValue name="group">{formatEventCount(props.group.length)}</KeyValue>
        <Show when={duration}>{d => <KeyValue name="duration">{d()}</KeyValue>}</Show>
      </KeyValueList>
      <For each={props.group}>{member => renderMember(member, formatMemberDelta(member, props.first))}</For>
    </>
  );
}

function renderHeadFields(event: StoredEvent): JSX.Element {
  switch (event.kind) {
    case 'truapi':
      return (
        <>
          <KeyValue name="requestId">
            <IdValue id={event.requestId} />
          </KeyValue>
          <KeyValue name="product">{formatProductId(event.productId)}</KeyValue>
        </>
      );
    case 'system':
      return (
        <>
          <KeyValue name="flowId">
            <IdValue id={event.flowId} />
          </KeyValue>
          <KeyValue name="source">{event.source}</KeyValue>
          <KeyValue name="layer">{event.layer}</KeyValue>
        </>
      );
  }
}

function renderMember(member: StoredEvent, delta: string | null): JSX.Element {
  switch (member.kind) {
    case 'truapi':
      return <TruapiMember member={member} delta={delta} />;
    case 'system':
      return <SystemMember member={member} delta={delta} />;
  }
}

function TruapiMember(props: { member: StoredTruapiEvent; delta: string | null }): JSX.Element {
  const member = untrack(() => props.member);
  const chain = getChainDetail(member.tag, member.payload);
  return (
    <div class={s['member']} data-testid="td-detail-member" data-seq={String(member.seq)}>
      <Stack stretch>
        <Inline>
          <Timestamp at={member.receivedAt} />
          <DirectionArrow direction={member.direction} />
          <MethodTag kind={getTagKind(member.tag)}>{member.tag}</MethodTag>
          <Latency text={props.delta} />
        </Inline>
        <ChainSummary chain={chain} />
        <ChainFields chain={chain} />
        <Payload payload={member.payload} />
      </Stack>
    </div>
  );
}

function SystemMember(props: { member: StoredSystemEvent; delta: string | null }): JSX.Element {
  const member = untrack(() => props.member);
  return (
    <div class={s['member']} data-testid="td-detail-member" data-seq={String(member.seq)}>
      <Stack stretch>
        <Inline>
          <Timestamp at={member.receivedAt} />
          <LayerBadge layer={member.layer} />
          <MethodTag kind="system">{member.event}</MethodTag>
          <Latency text={props.delta} />
        </Inline>
        <Summary text={summariseSystemEvent(member)} />
        <Explanation event={member} />
        <Payload payload={member.payload} />
      </Stack>
    </div>
  );
}
