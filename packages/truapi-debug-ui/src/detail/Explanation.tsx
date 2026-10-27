// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { getExplanationDetail, type ExplanationBlock, type InlineSegment } from '../model/getExplanationDetail.js';
import type { StoredSystemEvent } from '../model/storedEvent.js';
import s from './Explanation.module.css';

export function Explanation(props: { event: StoredSystemEvent }): JSX.Element {
  return (
    <Show when={getExplanationDetail(props.event)}>
      {detail => (
        <details class={s['explanation']} data-testid="td-detail-explanation">
          <summary class={s['toggle']}>What is this? ({detail().title})</summary>
          <div class={s['body']}>
            <For each={detail().blocks}>{block => renderBlock(block)}</For>
          </div>
        </details>
      )}
    </Show>
  );
}

function renderBlock(block: ExplanationBlock): JSX.Element {
  switch (block.kind) {
    case 'list':
      return (
        <ul class={s['list']}>
          <For each={block.items}>
            {item => (
              <li class={s['item']}>
                <Inline segments={item} />
              </li>
            )}
          </For>
        </ul>
      );
    case 'paragraph':
      return (
        <p class={s['paragraph']}>
          <Inline segments={block.segments} />
        </p>
      );
  }
}

function Inline(props: { segments: InlineSegment[] }): JSX.Element {
  return (
    <For each={props.segments}>
      {segment => (segment.code ? <code class={s['code']}>{segment.text}</code> : segment.text)}
    </For>
  );
}
