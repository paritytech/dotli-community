// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { formatPayloadDetail, type ChainDetail } from '@dotli/truapi-debug';
import { Callout } from '../shared/Callout.js';
import { Code } from '../shared/Code.js';
import { KeyValue, KeyValueList } from '../shared/KeyValueList.js';
import { SectionTitle } from '../shared/SectionTitle.js';
import s from './Sections.module.css';

/** What an event means, in prose. */
export function Summary(props: { text: string }): JSX.Element {
  return <Callout testId="td-detail-summary">{props.text}</Callout>;
}

export function ChainSummary(props: { chain: ChainDetail | null }): JSX.Element {
  return (
    <Show when={props.chain?.summary}>
      {summary => (
        <>
          <SectionTitle>Summary</SectionTitle>
          <Summary text={summary()} />
        </>
      )}
    </Show>
  );
}

export function ChainFields(props: { chain: ChainDetail | null }): JSX.Element {
  return (
    <Show when={props.chain}>
      {chain => (
        <>
          <SectionTitle>Chain</SectionTitle>
          <KeyValueList testId="td-chain-head">
            <For each={chain().fields}>
              {field => <KeyValue name={field.name}>{field.code ? <Code>{field.value}</Code> : field.value}</KeyValue>}
            </For>
          </KeyValueList>
        </>
      )}
    </Show>
  );
}

export function Payload(props: { payload: unknown }): JSX.Element {
  return (
    <pre class={s['payload']} data-testid="td-detail-pre">
      {formatPayloadDetail(props.payload)}
    </pre>
  );
}
