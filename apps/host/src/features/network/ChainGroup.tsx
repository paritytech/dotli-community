// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, For, Match, Show, Switch, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { prefersReducedMotion, Stack } from '@dotli/ui';
import type { ChainSummary } from './chain.js';
import {
  describeBehind,
  describeBlockDelay,
  describePeers,
  HISTORY_SLOTS,
  landedBars,
  pendingBar,
  sameBars,
  slotOpacity,
  type PendingBarView,
} from './chainStrip.js';
import s from './ChainGroup.module.css';

const STRIP_LABEL = `Last ${String(HISTORY_SLOTS)} blocks, newest on the right`;

/** Replay the instant shift that appended bars cause as a glide left, so a block arriving reads as an arrival. */
function slideStrip(strip: HTMLElement, landed: number): void {
  const style = getComputedStyle(strip);
  const gap = Number.parseFloat(style.columnGap) || 0;
  const first = strip.firstElementChild;
  const width = first === null ? 0 : first.getBoundingClientRect().width;
  // The strip starts this far to the right, so the landed bars glide in from where the old ones were.
  const shift = landed * (width + gap);
  if (shift <= 0) {
    return;
  }
  if (!prefersReducedMotion()) {
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
  }
  strip.removeAttribute('data-sliding');
  strip.style.transform = `translateX(${String(shift)}px)`;
  // Commit the untransitioned offset first, or the browser coalesces both writes and nothing moves.
  strip.getBoundingClientRect();
  strip.setAttribute('data-sliding', '');
  strip.style.transform = 'translateX(0)';
}

/** The ghost bar before a chain's first bar, in the newest slot. */
function PendingBar(props: { pending: PendingBarView }): JSX.Element {
  const height = (): JSX.CSSProperties | undefined =>
    props.pending.phase === 'searching' ? undefined : { height: `${String(props.pending.heightPercent)}%` };
  return (
    <>
      <Stubs count={HISTORY_SLOTS - 1} />
      <span
        class={[s['bar'], s['pending']]}
        data-testid="chains-bar-pending"
        data-pending={props.pending.phase}
        style={height()}
      />
    </>
  );
}

function Stubs(props: { count: number }): JSX.Element {
  const slots = createMemo(() => Array.from({ length: props.count }, (_, i) => i));
  return (
    <For each={slots()}>
      {slot => <span class={s['stub']} data-testid="chains-bar-stub" style={{ '--slot-opacity': slotOpacity(slot) }} />}
    </For>
  );
}

/** Bars keep their element while on screen, so new ones slide in instead of the strip being rebuilt. */
function BarStrip(props: { chain: ChainSummary; pending: PendingBarView | null }): JSX.Element {
  let strip: HTMLDivElement | undefined;
  // Updates that land no block keep the same bar objects, so the same bars mean no block landed.
  const visible = createMemo(
    () => {
      const list = props.chain.bars;
      return list.length > HISTORY_SLOTS ? list.slice(-HISTORY_SLOTS) : list;
    },
    { equals: sameBars },
  );
  createEffect(visible, (list, prev) => {
    if (strip === undefined || prev === undefined) {
      return;
    }
    const landed = landedBars(prev, list);
    if (landed > 0) {
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
      role="group"
      title={STRIP_LABEL}
      aria-label={`${props.chain.label}: ${STRIP_LABEL.toLowerCase()}`}
    >
      <Show
        when={props.chain.bars.length > 0}
        fallback={
          <Show when={props.pending} fallback={<Stubs count={HISTORY_SLOTS} />}>
            {view => <PendingBar pending={view()} />}
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
                data-testid="chains-bar"
                data-block={block}
                class={s['bar']}
                data-health={bar.health}
                style={{ '--slot-opacity': slotOpacity(HISTORY_SLOTS - visible().length + index()) }}
                title={delay}
                role="img"
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
 * One chain: its name with its state in words and its peers, over its recent blocks. Before a first block it shows a
 * ghost bar and an estimate, `sinceLast` ms after the chain's last block (null before any). `behind` marks a chain the
 * network verdict names as lagging. `unreachable` marks a network the verdict finds out of reach, so a chain with no
 * endpoint reads as the error the status names.
 */
export function ChainGroup(props: {
  chain: ChainSummary;
  sinceLast: number | null;
  behind?: boolean;
  unreachable?: boolean;
}): JSX.Element {
  // No caption rather than "0 peers" until a sample lands: zero is a different claim.
  const peers = createMemo(() =>
    props.chain.reachable && props.chain.state !== 'unused' && props.chain.peers !== null
      ? describePeers(props.chain.label, props.chain.peers)
      : null,
  );
  // Nothing is connecting a chain that is unused or has no endpoint, so it gets no ghost bar or countdown. Computed
  // once per tick, as both the caption and the bar read it.
  const pending = createMemo(() =>
    props.chain.reachable && props.chain.state !== 'unused' && props.chain.bars.length === 0
      ? pendingBar(props.chain, props.sinceLast)
      : null,
  );
  return (
    <Stack class={s['group']} testId="chains-group">
      <p
        class={s['groupLabel']}
        data-testid="chains-group-label"
        data-state={props.chain.state}
        data-unavailable={props.chain.reachable ? undefined : ''}
      >
        <span class={s['name']} data-testid="chains-group-name">
          {props.chain.label}
        </span>
        <Switch>
          <Match when={!props.chain.reachable}>
            <span
              class={s['caption']}
              data-tone={props.unreachable === true ? 'err' : 'warn'}
              data-testid="chains-group-no-endpoint"
            >
              No endpoint
            </span>
          </Match>
          <Match when={props.chain.state === 'unused'}>
            <span class={s['caption']} data-testid="chains-group-unused">
              Not in use
            </span>
          </Match>
          <Match when={props.behind === true}>
            <span class={s['caption']} data-tone="warn" data-testid="chains-group-behind">
              {describeBehind(props.chain.bars, props.chain.blockTimeMs)}
            </span>
          </Match>
          <Match when={pending()}>
            {view => (
              <span class={s['caption']} data-testid="chains-bars-waiting">
                {view().text}
              </span>
            )}
          </Match>
        </Switch>
        <Show when={peers()}>
          {count => (
            <span
              class={s['caption']}
              data-tone={count().tone === 'warn' ? 'warn' : undefined}
              data-testid="chains-group-peers"
              title={count().label}
            >
              {count().text}
            </span>
          )}
        </Show>
      </p>
      <div
        class={s['cell']}
        data-testid="chains-cell"
        data-state={props.chain.state}
        data-unavailable={props.chain.reachable ? undefined : ''}
      >
        <Show
          when={props.chain.reachable}
          fallback={
            <div class={s['bars']} data-testid="chains-bars">
              <Stubs count={HISTORY_SLOTS} />
            </div>
          }
        >
          <BarStrip chain={props.chain} pending={pending()} />
        </Show>
      </div>
    </Stack>
  );
}
