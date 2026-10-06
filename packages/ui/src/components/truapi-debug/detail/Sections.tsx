// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { formatPayloadDetail, type ChainDetail } from '@dotli/truapi-debug';
import { ChainCode, Field, Fields } from './Fields.js';
import s from './Sections.module.css';

export function SectionTitle(props: { children: string }): JSX.Element {
  return (
    <div class={s['title']} data-testid="td-detail-section-title">
      {props.children}
    </div>
  );
}

export function Summary(props: { text: string }): JSX.Element {
  return (
    <div class={s['summary']} data-testid="td-detail-summary">
      {props.text}
    </div>
  );
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
          <Fields testId="td-chain-head" chain>
            <For each={chain().fields}>
              {field => (
                <Field name={field.name}>{field.code ? <ChainCode>{field.value}</ChainCode> : field.value}</Field>
              )}
            </For>
          </Fields>
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
