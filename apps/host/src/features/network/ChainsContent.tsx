// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, For, Show, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Accordion, StatusDot, Surface, SurfaceHead, Well } from '@dotli/ui';
import { ChainRow } from './ChainRow.js';
import { isWatched } from './chain.js';
import type { ChainHealthFacts } from './chainHealth.js';
import { isNetworkOffline, NETWORK_HEALTH } from './networkVerdict.js';
import type { NetworkHealth } from './networkVerdict.js';
import type { ChainView, NetworkView } from './chains.js';
import { describeTransfer, type TransferRow } from './chainsFormat.js';
import s from './ChainsContent.module.css';

const TICK_MS = 250;

export type ChainsContentProps = {
  network: Accessor<NetworkView>;
  health: Accessor<NetworkHealth>;
  /** Until then the footer shows the product's download. */
  productLoaded: Accessor<boolean>;
};

/** A row of the transfer footer, which keeps its place while it has nothing to say. */
function TransferLine(props: { row: TransferRow | null }): JSX.Element {
  return (
    <p class={s['transferRow']} data-testid="chains-transfer-row">
      <Show when={props.row}>
        {row => (
          <>
            <span class={s['transferLabel']} data-testid="chains-transfer-label">
              {row().label}
            </span>
            <span class={s['transferValue']} data-testid="chains-transfer-value">
              {row().value}
            </span>
          </>
        )}
      </Show>
    </p>
  );
}

/** The network popover's body, its own chunk. */
export function ChainsContent(props: ChainsContentProps): JSX.Element {
  const knownChains = createMemo(() => props.network().chains.filter(chain => chain.role !== null));
  const otherChains = createMemo(() => props.network().chains.filter(chain => chain.role === null));

  const [now, setNow] = createSignal(Date.now());
  // The clock ticks only while a reachable chain is in use, as only those rows age between reads. A memo, as Solid 2
  // runs an effect's function every time its compute re-runs.
  const ticking = createMemo(() => props.network().chains.some(isWatched));
  createEffect(ticking, on => {
    if (!on) {
      return;
    }
    const ticker = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(ticker);
    };
  });
  const facts = (chain: ChainView): ChainHealthFacts => ({
    sinceRead: now() - props.network().readAt,
    behind: props.network().verdict.slow?.includes(chain.label) === true,
    offline: isNetworkOffline(props.health()),
    unreachable: props.network().verdict.tone === 'unreachable',
  });
  const transfer = createMemo(() => describeTransfer(props.network().transfer, !props.productLoaded()));
  return (
    <Surface width="md" padded testId="chains-content">
      <SurfaceHead
        title="Network"
        testId="chains-head"
        aside={
          <StatusDot
            tone={NETWORK_HEALTH[props.health()].dot}
            label={NETWORK_HEALTH[props.health()].word}
            testId="chains-status-dot"
          />
        }
      />
      <Show when={knownChains().length > 0}>
        <Well layout="list" testId="chains-list">
          <For each={knownChains()} keyed={chain => chain.key}>
            {chain => <ChainRow chain={chain()} facts={facts(chain())} />}
          </For>
        </Well>
      </Show>
      <Show when={otherChains().length > 0}>
        <Accordion
          title={`Other chains (${String(otherChains().length)})`}
          testId="chains-other"
          summaryTestId="chains-other-summary"
        >
          <Well layout="list" testId="chains-other-list">
            <For each={otherChains()} keyed={chain => chain.key}>
              {chain => <ChainRow chain={chain()} facts={facts(chain())} />}
            </For>
          </Well>
        </Accordion>
      </Show>
      <div
        class={s['transfer']}
        data-testid="chains-transfer"
        data-empty={transfer().speed === null && transfer().size === null ? '' : undefined}
      >
        <TransferLine row={transfer().speed} />
        <TransferLine row={transfer().size} />
      </div>
    </Surface>
  );
}
