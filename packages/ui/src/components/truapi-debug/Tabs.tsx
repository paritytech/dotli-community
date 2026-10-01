// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';

export type PanelView = 'list' | 'timeline' | 'resolution' | 'runtime' | 'wallet';

const TABS: readonly { view: PanelView; label: string }[] = [
  { view: 'list', label: 'List' },
  { view: 'timeline', label: 'Timeline' },
  { view: 'resolution', label: 'Resolution' },
];

export function Tabs(props: {
  view: PanelView;
  wallet?: boolean;
  runtime?: boolean;
  onSelect: (view: PanelView) => void;
}): JSX.Element {
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
      <Show when={props.runtime}>
        <button
          class={props.view === 'runtime' ? 'td-tab active' : 'td-tab'}
          role="tab"
          aria-selected={props.view === 'runtime' ? 'true' : 'false'}
          data-view="runtime"
          type="button"
          onClick={() => {
            props.onSelect('runtime');
          }}
        >
          Runtime
        </button>
      </Show>
      <Show when={props.wallet}>
        <button
          id="td-tab-wallet"
          class={props.view === 'wallet' ? 'td-tab active' : 'td-tab'}
          role="tab"
          data-view="wallet"
          type="button"
          onClick={() => {
            props.onSelect('wallet');
          }}
        >
          Wallet
        </button>
      </Show>
    </div>
  );
}
