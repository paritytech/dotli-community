// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './Tabs.module.css';

export type PanelView = 'list' | 'timeline' | 'resolution' | 'archive' | 'diagnostics' | 'wallet';

const TABS: readonly { view: PanelView; label: string }[] = [
  { view: 'list', label: 'List' },
  { view: 'timeline', label: 'Timeline' },
  { view: 'resolution', label: 'Resolution' },
  { view: 'archive', label: 'Archive' },
  { view: 'diagnostics', label: 'Diagnostics' },
  { view: 'wallet', label: 'Wallet' },
];

export function Tabs(props: { view: PanelView; onSelect: (view: PanelView) => void }): JSX.Element {
  return (
    <div class={s['tabs']} data-testid="td-tabs" role="tablist">
      <For each={TABS}>
        {tab => (
          <button
            class={s['tab']}
            data-testid="td-tab"
            role="tab"
            aria-selected={props.view === tab.view ? 'true' : 'false'}
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
