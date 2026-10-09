// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ChainStatus } from '../../network-monitor.js';
import { shallowEqual } from '../../state/create-store.js';
import { networkStore } from '../../state/network.js';
import { networkHealthStore } from '../../state/network-health.js';
import { productStore } from '../../state/product.js';
import { settingsStore } from '../../state/settings.js';
import { Chip } from '../primitives/Chip.js';
import { Stack } from '../primitives/SectionLabel.js';
import { StatusDot } from '../primitives/StatusDot.js';
import { Surface, SurfaceHead } from '../primitives/Surface.js';
import { Callout, InfoIcon, Well } from '../primitives/Well.js';
import { useStore } from '../use-store.js';
import {
  describeBlockDelay,
  describeLiveNetwork,
  describeNetworkStatus,
  formatRate,
  formatSize,
  HISTORY_SLOTS,
  slotOpacity,
} from './chains-format.js';
import s from './ChainsContent.module.css';

const PENDING_TICK_MS = 250;

const TIP = 'For steadier peers, close tabs and apps you are not using and stay close to your router.';

/** Replay the instant shift that appended bars cause as a glide left, so a block arriving reads as an arrival. */
function slideStrip(strip: HTMLElement, landed: number): void {
  const style = getComputedStyle(strip);
  const gap = Number.parseFloat(style.columnGap) || 0;
  const first = strip.firstElementChild;
  const width = first === null ? 0 : first.getBoundingClientRect().width;
  const shift = landed * (width + gap);
  if (shift <= 0) {
    return;
  }
  for (const node of Array.from(strip.children).slice(-landed)) {
    const mark = node as HTMLElement;
    mark.setAttribute('data-new', '');
    mark.addEventListener(
      'animationend',
      () => {
        mark.removeAttribute('data-new');
      },
      { once: true },
    );
  }
  strip.removeAttribute('data-sliding');
  strip.style.transform = `translateX(${String(shift)}px)`;
  // Commit the untransitioned offset first, or the browser coalesces both writes and nothing moves.
  strip.getBoundingClientRect();
  strip.setAttribute('data-sliding', '');
  strip.style.transform = 'translateX(0)';
}

/**
 * The ghost bar and estimate before a chain's first bar.
 * The copy never shows zero or a negative: past the estimate it swaps to words, and past 3x the verdict escalates.
 */
function PendingBar(props: { chain: ChainStatus; sinceLast: number | null }): JSX.Element {
  // Read four times per render: computed once per tick.
  const pending = createMemo(
    (): {
      phase: 'searching' | 'counting' | 'due';
      height?: string;
      text: string;
    } => {
      const since = props.sinceLast;
      if (since === null) {
        return {
          phase: 'searching',
          text: props.chain.phase ?? 'connecting',
        };
      }
      const fraction = Math.min(since / props.chain.blockTimeMs, 1);
      const height = `${String(Math.round(20 + fraction * 80))}%`;
      const leftMs = props.chain.blockTimeMs - since;
      return leftMs > 0
        ? {
            phase: 'counting',
            height,
            text: `next block in about ${String(Math.ceil(leftMs / 1000))}s`,
          }
        : { phase: 'due', height, text: 'due any moment' };
    },
  );
  return (
    <>
      <Stubs count={HISTORY_SLOTS - 1} />
      <span
        class={[s['bar'], s['pending']]}
        data-testid="chains-bar-pending"
        data-pending={pending().phase}
        style={pending().height === undefined ? undefined : { height: pending().height }}
      />
      <span class={s['waiting']} data-testid="chains-bars-waiting">
        {pending().text}
      </span>
    </>
  );
}

function Stubs(props: { count: number }): JSX.Element {
  const slots = createMemo(() => Array.from({ length: Math.max(0, props.count) }, (_, i) => i));
  return (
    <For each={slots()}>
      {slot => <span class={s['stub']} data-testid="chains-bar-stub" style={{ opacity: slotOpacity(slot) }} />}
    </For>
  );
}

/** Bars keep their element while on screen, so new ones slide in instead of the strip being rebuilt. */
function BarStrip(props: { chain: ChainStatus; sinceLast: number | null }): JSX.Element {
  let strip: HTMLDivElement | undefined;
  // The store is rebuilt on every monitor notification, but the monitor never changes a bar object, so the
  // same bars mean no block landed.
  const bars = createMemo(() => props.chain.bars, { equals: shallowEqual });
  const visible = createMemo(
    () => {
      const list = bars();
      return list.length > HISTORY_SLOTS ? list.slice(-HISTORY_SLOTS) : list;
    },
    { equals: shallowEqual },
  );
  createEffect(visible, (list, prev) => {
    if (strip === undefined || prev === undefined) {
      return;
    }
    // Count only blocks newer than the newest shown, so a re-render with the same history slides nothing.
    const newest = prev.at(-1)?.number;
    const landed = newest === undefined ? list.length : list.filter(bar => bar.number > newest).length;
    // Bars landing in a strip that showed none appear without sliding.
    if (landed > 0 && list.length > landed) {
      slideStrip(strip, landed);
    }
  });
  return (
    <div
      ref={el => {
        strip = el;
      }}
      class={s['bars']}
      data-testid="chains-bars"
    >
      <Show
        when={props.chain.bars.length > 0}
        fallback={
          // Nothing is connecting an unused chain, so it gets no ghost bar or countdown.
          <Show when={props.chain.state !== 'unused'} fallback={<Stubs count={HISTORY_SLOTS} />}>
            <PendingBar chain={props.chain} sinceLast={props.sinceLast} />
          </Show>
        }
      >
        <Stubs count={HISTORY_SLOTS - visible().length} />
        <For each={visible()}>
          {(bar, index) => {
            const block = String(bar.number);
            const delay = describeBlockDelay(
              bar.gapMs,
              untrack(() => props.chain.blockTimeMs),
            );
            return (
              <span
                data-block={block}
                class={s['bar']}
                data-health={bar.health}
                style={{ opacity: slotOpacity(HISTORY_SLOTS - visible().length + index()) }}
                title={delay}
                aria-label={`Block ${block}, ${delay}`}
              />
            );
          }}
        </For>
      </Show>
    </div>
  );
}

function ChainGroup(props: { chain: ChainStatus; sinceLast: number | null }): JSX.Element {
  const unused = (): boolean => props.chain.state === 'unused';
  // No chip rather than "0 peers" until a sample lands: zero is a different claim. An unused chain claims none.
  const peers = (): number | null => (props.chain.reachable && !unused() ? props.chain.peers : null);
  return (
    <Stack class={s['group']}>
      <p class={s['groupLabel']} data-testid="chains-group-label" data-state={props.chain.state}>
        <span>{props.chain.label}</span>
        <Show
          when={!unused() || !props.chain.reachable}
          fallback={
            <Chip tone="mono" testId="chains-group-unused">
              Not in use
            </Chip>
          }
        >
          <Show when={peers() !== null}>
            <Chip
              tone="mono"
              testId="chains-group-peers"
              alert={peers() === 0}
              label={`${props.chain.label}: ${String(peers())} ${peers() === 1 ? 'peer' : 'peers'} connected`}
            >
              {peers() === 1 ? '1 peer' : `${String(peers())} peers`}
            </Chip>
          </Show>
        </Show>
      </p>
      <div
        class={s['cell']}
        data-testid="chains-cell"
        data-state={props.chain.state}
        data-unavailable={props.chain.reachable ? undefined : ''}
      >
        <Show when={props.chain.reachable} fallback="no endpoint on this network">
          <BarStrip chain={props.chain} sinceLast={props.sinceLast} />
        </Show>
      </div>
    </Stack>
  );
}

/** The network popover's body, its own chunk. */
export function ChainsContent(): JSX.Element {
  const network = useStore(networkStore);
  const health = useStore(networkHealthStore);
  const product = useStore(productStore);
  const settings = useStore(settingsStore);
  // Both backends produce block arrivals, so only the captions follow the backend. A memo, as it is read
  // three times per render.
  const status = createMemo(() =>
    describeNetworkStatus(
      describeLiveNetwork(network().chains),
      health() === 'err',
      network().chains.filter(chain => chain.state === 'live').length,
      settings()?.backend,
    ),
  );
  const knownChains = createMemo(() => network().chains.filter(chain => chain.role !== null));
  const otherChains = createMemo(() => network().chains.filter(chain => chain.role === null));

  const [now, setNow] = createSignal(Date.now());
  // Once every chain has bars nothing reads `now`, so the ticker stops. A memo, as Solid 2 runs an effect's
  // function every time its compute re-runs.
  const counting = createMemo(() =>
    network().chains.some(
      chain => chain.reachable && chain.state !== 'unused' && chain.bars.length === 0 && chain.sinceLast !== null,
    ),
  );
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
  const sinceLast = (chain: ChainStatus): number | null =>
    chain.sinceLast === null ? null : chain.sinceLast + Math.max(0, now() - network().readAt);
  // Once the product is on screen speed and size describe history, so the footer empties.
  const loading = (): boolean => product().status !== 'loaded';
  const speed = (): string | null => {
    const { bytesPerSecond } = network().transfer;
    return loading() && bytesPerSecond !== null ? formatRate(bytesPerSecond) : null;
  };
  const size = (): { label: string; value: string } | null => {
    const { fetched, total } = network().transfer;
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
    <Surface width="md" class={s['panel']} testId="chains-content">
      <SurfaceHead title="Network" />
      <Well class={s['status']} testId="chains-status">
        <StatusDot tone={status().tone} testId="chains-status-dot" />
        <div class={s['statusText']}>
          <p class={s['statusTitle']}>{status().title}</p>
          <Show when={status().detail}>{detail => <p class={s['statusDetail']}>{detail()}</p>}</Show>
        </div>
      </Well>
      <For each={knownChains()} keyed={chain => chain.key}>
        {chain => <ChainGroup chain={chain()} sinceLast={sinceLast(chain())} />}
      </For>
      <Show when={otherChains().length > 0}>
        <details class={s['other']} data-testid="chains-other">
          <summary class={s['otherSummary']} data-testid="chains-other-summary">
            Other chains ({otherChains().length})
          </summary>
          <For each={otherChains()} keyed={chain => chain.key}>
            {chain => <ChainGroup chain={chain()} sinceLast={sinceLast(chain())} />}
          </For>
        </details>
      </Show>
      <div class={s['transfer']}>
        <p class={s['transferRow']} data-testid="chains-transfer-row">
          <Show when={speed()}>
            {rate => (
              <>
                <span class={s['transferLabel']}>Speed</span>
                <span class={s['transferValue']}>{rate()}</span>
              </>
            )}
          </Show>
        </p>
        <p class={s['transferRow']} data-testid="chains-transfer-row">
          <Show when={size()}>
            {row => (
              <>
                <span class={s['transferLabel']}>{row().label}</span>
                <span class={s['transferValue']}>{row().value}</span>
              </>
            )}
          </Show>
        </p>
      </div>
      {/* Trusted providers have no peers to steady. */}
      <Show when={settings()?.backend !== 'rpc-gateway'}>
        <Callout icon={<InfoIcon />} testId="chains-tips">
          {TIP}
        </Callout>
      </Show>
    </Surface>
  );
}
