// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For } from 'solid-js';
import type { JSX } from '@solidjs/web';

export type PanelView = 'list' | 'timeline' | 'resolution' | 'archive';

const TABS: readonly { view: PanelView; label: string }[] = [
  { view: 'list', label: 'List' },
  { view: 'timeline', label: 'Timeline' },
  { view: 'resolution', label: 'Resolution' },
  { view: 'archive', label: 'Archive' },
];

export function Tabs(props: { view: PanelView; onSelect: (view: PanelView) => void }): JSX.Element {
  return (
    <div class="td-tabs" role="tablist">
      <For each={TABS}>
        {tab => (
          <button
            class={props.view === tab.view ? 'td-tab active' : 'td-tab'}
            role="tab"
            data-view={tab.view}
            type="button"
            onClick={() => {
              props.onSelect(tab.view);
            }}
          >
            {tab.label}
          </button>
        )}
      </For>
    </div>
  );
}
