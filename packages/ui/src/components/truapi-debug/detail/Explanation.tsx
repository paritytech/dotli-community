// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Collapsible "What is this?" block under a system event's summary. Native
// <details>/<summary>, so keyboard and assistive tech work out of the box.

import { For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { explanationDetail, type InlineSegment, type StoredSystemEvent } from '@dotli/truapi-debug';
import s from './Explanation.module.css';

export function Explanation(props: { event: StoredSystemEvent }): JSX.Element {
  return (
    <Show when={explanationDetail(props.event)}>
      {detail => (
        <details class={s['explanation']} data-testid="td-detail-explanation">
          <summary class={s['toggle']}>What is this? — {detail().title}</summary>
          <div class={s['body']}>
            <For each={detail().blocks}>
              {block =>
                block.kind === 'list' ? (
                  <ul class={s['list']}>
                    <For each={block.items}>
                      {item => (
                        <li class={s['item']}>
                          <Inline segments={item} />
                        </li>
                      )}
                    </For>
                  </ul>
                ) : (
                  <p class={s['paragraph']}>
                    <Inline segments={block.segments} />
                  </p>
                )
              }
            </For>
          </div>
        </details>
      )}
    </Show>
  );
}

/** Prose with its backticked identifiers as code. */
function Inline(props: { segments: InlineSegment[] }): JSX.Element {
  return (
    <For each={props.segments}>
      {segment => (segment.code ? <code class={s['code']}>{segment.text}</code> : segment.text)}
    </For>
  );
}
