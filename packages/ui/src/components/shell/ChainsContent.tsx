// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { NETWORK_NAME_TO_SERVICES_CONFIG } from '@dotli/config';
import type { ChainStatus } from '../../network-monitor.js';
import { shallowEqual } from '../../state/create-store.js';
import { networkStore, watchNetwork } from '../../state/network.js';
import { networkHealthStore } from '../../state/network-health.js';
import { productStore } from '../../state/product.js';
import { settingsStore } from '../../state/settings.js';
import { Chip } from '../primitives/Chip.js';
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
import { usePopover } from './Popover.js';
import s from './ChainsContent.module.css';

/**
 * How often the pending cells' countdown is recomputed while open and a
 * chain is waiting for its first block.
 */
const PENDING_TICK_MS = 250;

const TIP = 'For steadier peers, close tabs and apps you are not using and stay close to your router.';

/**
 * Glide the strip left by the room the newly landed bars just took.
 *
 * The bars are packed to the right, so appending one shifts every older bar
 * left instantly. Starting the strip offset by that same distance and
 * transitioning it back to zero (`data-sliding`) replays the shift as
 * motion, which is what makes a block arriving read as an arrival. Each
 * new bar is marked `data-new` until its landing animation ends.
 */
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
  // Read back so the untransitioned offset is committed before the class that
  // animates it is added. Without this the browser coalesces both into the
  // final position and nothing moves.
  strip.getBoundingClientRect();
  strip.setAttribute('data-sliding', '');
  strip.style.transform = 'translateX(0)';
}

/**
 * The ghost bar and live estimate a chain shows before its first bar.
 *
 * Before the first head nothing is predictable, so the slot says where the
 * chain is instead of a number. After it, the next block is genuinely due
 * within the chain-declared block time. The copy never shows zero or a
 * negative: past the estimate it swaps to words, and past 3x the verdict line
 * escalates, so "due any moment" cannot linger.
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

/** The empty slots of a strip that has fewer samples than slots, at the left. */
function Stubs(props: { count: number }): JSX.Element {
  const slots = createMemo(() => Array.from({ length: Math.max(0, props.count) }, (_, i) => i));
  return (
    <For each={slots()}>
      {slot => <span class={s['stub']} data-testid="chains-bar-stub" style={{ opacity: slotOpacity(slot) }} />}
    </For>
  );
}

/**
 * One chain's strip of block bars: always 48 slots, filled from the right as
 * samples arrive, the rest stubs. Bars keep their element while they stay on
 * screen, so newly landed ones slide in (see slideStrip) instead of the strip
 * being rebuilt.
 */
function BarStrip(props: { chain: ChainStatus; sinceLast: number | null }): JSX.Element {
  let strip: HTMLDivElement | undefined;
  // The network store is rebuilt on every monitor notification, speed
  // samples included. The monitor adds a new bar object per block and never
  // changes one, so the same bars mean no block landed, and nothing below
  // runs for such an update.
  const bars = createMemo(() => props.chain.bars, { equals: shallowEqual });
  // Only the newest slots' worth is drawn. The rest stay in the monitor.
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
    // Only blocks newer than the newest shown landed: bars revealed on the
    // left by a wider strip are history, not arrivals.
    const newest = prev.at(-1)?.number;
    const landed = newest === undefined ? list.length : list.filter(bar => bar.number > newest).length;
    // Bars landing in a strip that showed none (on opening, or after the
    // pending cell) appear without sliding.
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
        fallback={<PendingBar chain={props.chain} sinceLast={props.sinceLast} />}
      >
        <Stubs count={HISTORY_SLOTS - visible().length} />
        <For each={visible()}>
          {(bar, index) => {
            const block = String(bar.number);
            // Hovering a bar answers the only question it raises: how late
            // was it.
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

/**
 * A labelled strip per chain. The bars answer whether blocks are arriving;
 * the peer count beside the name answers who they are arriving from.
 */
function ChainGroup(props: { chain: ChainStatus; sinceLast: number | null }): JSX.Element {
  // Blank rather than "0 peers" until a sample lands: before the first reply
  // the shell does not know the count, and zero is a different claim.
  const peers = (): number | null => (props.chain.reachable ? props.chain.peers : null);
  return (
    <div class={s['group']}>
      <p class={s['groupLabel']} data-testid="chains-group-label">
        <span>{props.chain.label}</span>
        <span
          class={s['peers']}
          data-testid="chains-group-peers"
          data-none={peers() === 0 ? '' : undefined}
          aria-label={
            peers() === null
              ? undefined
              : `${props.chain.label}: ${String(peers())} ${peers() === 1 ? 'peer' : 'peers'} connected`
          }
        >
          {peers() === null ? '' : peers() === 1 ? '1 peer' : `${String(peers())} peers`}
        </span>
      </p>
      <div class={s['cell']} data-unavailable={props.chain.reachable ? undefined : ''}>
        <Show when={props.chain.reachable} fallback="no endpoint on this network">
          <BarStrip chain={props.chain} sinceLast={props.sinceLast} />
        </Show>
      </div>
    </div>
  );
}

/**
 * The network popover's body (ChainsPopover), its own chunk, rendered while
 * the popover is open: the head with the network, the status line (its tone
 * as the dot's `data-tone`), the chains, the transfer rows and the tips.
 * Every chain's block arrivals are watched while it is mounted.
 */
export function ChainsContent(): JSX.Element {
  const popover = usePopover();
  // Once mounted: the watch goes with the content.
  onSettled(() => watchNetwork());
  const network = useStore(networkStore);
  const health = useStore(networkHealthStore);
  const product = useStore(productStore);
  const settings = useStore(settingsStore);
  // The verdict reads from block arrivals, which both backends produce, so a
  // gateway connection reports its health the same way a light client does.
  // Only the captions follow the backend. Read three times per render: worked out once per update.
  const status = createMemo(() =>
    describeNetworkStatus(
      describeLiveNetwork(network().chains),
      health() === 'offline',
      network().chains.filter(chain => chain.reachable).length,
      settings()?.backend,
    ),
  );
  /** The network the host runs, once the host has seeded the settings. */
  const networkLabel = (): string | undefined => {
    const current = settings();
    return current === null ? undefined : NETWORK_NAME_TO_SERVICES_CONFIG[current.network].label;
  };

  const [now, setNow] = createSignal(Date.now());
  // Only a chain still waiting for its first block shows a countdown (its
  // pending cell); once every chain has bars, nothing reads `now`, so the
  // ticker stops. A memo, as Solid 2 runs an effect's function every time
  // its compute re-runs.
  const counting = createMemo(() =>
    network().chains.some(chain => chain.reachable && chain.bars.length === 0 && chain.sinceLast !== null),
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
  /** How long ago the chain's last block landed, as of the latest tick. */
  const sinceLast = (chain: ChainStatus): number | null =>
    chain.sinceLast === null ? null : chain.sinceLast + Math.max(0, now() - network().readAt);
  // Speed and size describe the load. Once the product is on screen they
  // describe history, so the footer empties rather than sitting at its final
  // numbers forever.
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
    <Surface width="md" bare sheet={popover.sheet()} testId="chains-content">
      <SurfaceHead
        title="Network"
        aside={
          <Show when={networkLabel()}>
            {label => (
              <Chip tone="mono" testId="chains-network">
                {label()}
              </Chip>
            )}
          </Show>
        }
      />
      <Well class={s['status']} testId="chains-status">
        <StatusDot tone={status().tone} testId="chains-status-dot" />
        <div class={s['statusText']}>
          <p class={s['statusTitle']}>{status().title}</p>
          <Show when={status().detail}>{detail => <p class={s['statusDetail']}>{detail()}</p>}</Show>
        </div>
      </Well>
      <For each={network().chains} keyed={chain => chain.role}>
        {chain => <ChainGroup chain={chain()} sinceLast={sinceLast(chain())} />}
      </For>
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
      {/* What a visitor can actually do about a slow connection. */}
      <Callout icon={<InfoIcon />} testId="chains-tips">
        {TIP}
      </Callout>
    </Surface>
  );
}
