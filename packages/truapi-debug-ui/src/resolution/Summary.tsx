// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Keyed by fact name, so the hovered info badge is never replaced and its tooltip stays up across ticks.

import { createMemo, For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ResolutionModel } from '@dotli/truapi-debug';
import { summaryFacts } from './format.js';
import s from './Summary.module.css';

export function Summary(props: { model: ResolutionModel }): JSX.Element {
  const facts = createMemo(() => summaryFacts(props.model));
  return (
    <dl class={s['summary']} data-testid="td-res-summary">
      <For each={facts()} keyed={fact => fact.key}>
        {fact => (
          <div data-testid="td-res-fact" data-fact={fact().key}>
            <dt class={s['key']}>
              {fact().key}
              {/* The only hover target, so the pointer can cross the grid without tooltips firing. */}
              <span
                class={s['info']}
                data-testid="td-res-info"
                data-tooltip={fact().hint}
                data-tooltip-prose=""
                aria-hidden="true"
              >
                i
              </span>
            </dt>
            <dd class={s['value']}>
              <span
                class={s['text']}
                data-testid="td-res-value"
                data-tone={fact().value.tone}
                data-tooltip={fact().value.tooltip}
                data-tooltip-prose={fact().value.tooltip === undefined ? undefined : ''}
              >
                {fact().value.text}
              </span>
            </dd>
          </div>
        )}
      </For>
    </dl>
  );
}
