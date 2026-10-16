// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, For, Show, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Backend } from '@dotli/config';
import { formatRate, formatSize } from '@dotli/shared';
import { InfoIcon } from '@dotli/ui/icons';
import { Accordion, Callout, StatusDot, Surface, SurfaceHead, Well } from '@dotli/ui';
import { ChainGroup } from './ChainGroup.js';
import type { NetworkHealth } from './network-health.js';
import type { ChainView, NetworkView } from './chains.js';
import { describeNetworkStatus, needsCountdown } from './chains-format.js';
import s from './ChainsContent.module.css';

const PENDING_TICK_MS = 250;

const TIP = 'For steadier peers, close tabs and apps you are not using and stay close to your router.';

export interface ChainsContentProps {
  network: Accessor<NetworkView>;
  health: Accessor<NetworkHealth>;
  /** Until then the footer shows the product's download. */
  productLoaded: Accessor<boolean>;
  /** Undefined until the page has read its settings. */
  backend: Accessor<Backend | undefined>;
}

/** The network popover's body, its own chunk. */
export function ChainsContent(props: ChainsContentProps): JSX.Element {
  // Both backends produce block arrivals, so only the captions follow the backend. A memo, as it is read
  // three times per render.
  const status = createMemo(() =>
    describeNetworkStatus(
      props.network().verdict,
      props.health() === 'err',
      props.network().chains.filter(chain => chain.state === 'live').length,
      props.backend(),
    ),
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
  const sinceLast = (chain: ChainView): number | null =>
    chain.sinceLast === null ? null : chain.sinceLast + Math.max(0, now() - props.network().readAt);
  // Once the product is on screen speed and size describe history, so the footer empties.
  const loading = (): boolean => !props.productLoaded();
  const speed = (): string | null => {
    const { bytesPerSecond } = props.network().transfer;
    return loading() && bytesPerSecond !== null ? formatRate(bytesPerSecond) : null;
  };
  const size = (): { label: string; value: string } | null => {
    const { fetched, total } = props.network().transfer;
    if (!loading() || fetched === null || total === null || total <= 0) {
      return null;
    }
    return fetched >= total
      ? { label: 'Size', value: formatSize(total) }
      : {
          label: 'Downloading',
          value: `${formatSize(fetched)} / ${formatSize(total)}`,
        };
  };
  return (
    <Surface width="md" padded testId="chains-content">
      <SurfaceHead title="Network" testId="chains-head" />
      <Well class={s['status']} testId="chains-status">
        <StatusDot tone={status().tone} testId="chains-status-dot" />
        <div class={s['statusText']}>
          <p class={s['statusTitle']} data-testid="chains-status-title">
            {status().title}
          </p>
          <Show when={status().detail}>
            {detail => (
              <p class={s['statusDetail']} data-testid="chains-status-detail">
                {detail()}
              </p>
            )}
          </Show>
        </div>
      </Well>
      <For each={knownChains()} keyed={chain => chain.key}>
        {chain => <ChainGroup chain={chain()} sinceLast={sinceLast(chain())} />}
      </For>
      <Show when={otherChains().length > 0}>
        <Accordion
          title={`Other chains (${String(otherChains().length)})`}
          testId="chains-other"
          summaryTestId="chains-other-summary"
        >
          <div class={s['other']}>
            <For each={otherChains()} keyed={chain => chain.key}>
              {chain => <ChainGroup chain={chain()} sinceLast={sinceLast(chain())} />}
            </For>
          </div>
        </Accordion>
      </Show>
      <div class={s['transfer']}>
        <p class={s['transferRow']} data-testid="chains-transfer-row">
          <Show when={speed()}>
            {rate => (
              <>
                <span class={s['transferLabel']} data-testid="chains-transfer-label">
                  Speed
                </span>
                <span class={s['transferValue']} data-testid="chains-transfer-value">
                  {rate()}
                </span>
              </>
            )}
          </Show>
        </p>
        <p class={s['transferRow']} data-testid="chains-transfer-row">
          <Show when={size()}>
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
      </div>
      {/* Trusted providers have no peers to steady. */}
      <Show when={props.backend() !== 'rpc-gateway'}>
        <Callout icon={InfoIcon} testId="chains-tips">
          {TIP}
        </Callout>
      </Show>
    </Surface>
  );
}
