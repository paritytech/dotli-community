// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './Tabs.module.css';
import { WALLET_TAB_ID } from './wallet/WalletView.js';

export type PanelView = 'list' | 'timeline' | 'resolution' | 'archive' | 'diagnostics' | 'wallet';

const TABS: readonly { view: PanelView; label: string }[] = [
  { view: 'list', label: 'List' },
  { view: 'timeline', label: 'Timeline' },
  { view: 'resolution', label: 'Resolution' },
  { view: 'archive', label: 'Archive' },
  { view: 'diagnostics', label: 'Diagnostics' },
];

export function Tabs(props: {
  view: PanelView;
  /** Show the debug-build Wallet tab. */
  wallet?: boolean;
  onSelect: (view: PanelView) => void;
}): JSX.Element {
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
      <Show when={props.wallet}>
        <button
          id={WALLET_TAB_ID}
          class={s['tab']}
          data-testid="td-tab"
          role="tab"
          aria-selected={props.view === 'wallet' ? 'true' : 'false'}
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
