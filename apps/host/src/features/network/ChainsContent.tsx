// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, For, Show, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Backend } from '@dotli/config';
import { InfoIcon } from '@dotli/ui/icons';
import { Accordion, Callout, StatusDot, Surface, SurfaceHead, Well } from '@dotli/ui';
import { ChainRow } from './ChainRow.js';
import type { ChainHealthFacts } from './chainHealth.js';
import { isNetworkOffline, NETWORK_HEALTH } from './networkVerdict.js';
import type { NetworkHealth } from './networkVerdict.js';
import type { ChainView, NetworkView } from './chains.js';
import {
  describeNetworkStatus,
  describeTransfer,
  isLightClientOrUnread,
  needsCountdown,
  type TransferRow,
} from './chainsFormat.js';
import s from './ChainsContent.module.css';

const PENDING_TICK_MS = 250;

const TIP = 'For steadier peers, close tabs and apps you are not using and stay close to your router.';

export type ChainsContentProps = {
  network: Accessor<NetworkView>;
  health: Accessor<NetworkHealth>;
  /** Until then the footer shows the product's download. */
  productLoaded: Accessor<boolean>;
  /** Undefined until the page has read its settings. */
  backend: Accessor<Backend | undefined>;
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
  // Both backends produce block arrivals, so only the captions follow the backend. A memo, as it is read
  // three times per render.
  const status = createMemo(() =>
    describeNetworkStatus({
      verdict: props.network().verdict,
      offline: isNetworkOffline(props.health()),
      chains: props.network().chains,
      backend: props.backend(),
    }),
  );
  const knownChains = createMemo(() => props.network().chains.filter(chain => chain.role !== null));
  const otherChains = createMemo(() => props.network().chains.filter(chain => chain.role === null));

  const [now, setNow] = createSignal(Date.now());
  // Once every chain has bars nothing reads `now`, so the ticker stops. A memo, as Solid 2 runs an effect's
  // function every time its compute re-runs.
  const counting = createMemo(() => needsCountdown(props.network().chains));
  createEffect(counting, on => {
    if (!on) {
      return;
    }
    const ticker = setInterval(() => {
      setNow(Date.now());
    }, PENDING_TICK_MS);
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
    <Surface width="md" padded class={s['content']} testId="chains-content">
      <SurfaceHead title="Network" testId="chains-head" />
      <Well class={s['status']} testId="chains-status">
        <StatusDot tone={NETWORK_HEALTH[status().tone].dot} class={s['statusDot']} testId="chains-status-dot" />
        <div class={s['statusText']}>
          <p class={s['statusTitle']} data-testid="chains-status-title">
            {status().title}
          </p>
          <p class={s['statusDetail']} data-testid="chains-status-detail">
            {status().detail}
          </p>
        </div>
      </Well>
      <For each={knownChains()} keyed={chain => chain.key}>
        {chain => <ChainRow chain={chain()} facts={facts(chain())} />}
      </For>
      <Show when={otherChains().length > 0}>
        <Accordion
          title={`Other chains (${String(otherChains().length)})`}
          testId="chains-other"
          summaryTestId="chains-other-summary"
        >
          <div class={s['other']}>
            <For each={otherChains()} keyed={chain => chain.key}>
              {chain => <ChainRow chain={chain()} facts={facts(chain())} />}
            </For>
          </div>
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
      {/* Trusted providers have no peers to steady, and a good, quiet or offline network gains nothing from it. */}
      <Show when={isLightClientOrUnread(props.backend()) && (status().tone === 'idle' || status().tone === 'warn')}>
        <Callout icon={InfoIcon} class={s['tips']} testId="chains-tips">
          {TIP}
        </Callout>
      </Show>
    </Surface>
  );
}
