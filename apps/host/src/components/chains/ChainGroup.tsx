// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Chip, prefersReducedMotion, Stack } from '@dotli/ui';
import type { ChainSummary } from './chain.js';
import {
  describeBlockDelay,
  describePeers,
  HISTORY_SLOTS,
  landedBars,
  pendingBar,
  sameBars,
  slotOpacity,
} from './chainStrip.js';
import s from './ChainGroup.module.css';

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

/** The ghost bar and estimate before a chain's first bar. */
function PendingBar(props: { chain: ChainSummary; sinceLast: number | null }): JSX.Element {
  // Read four times per render: computed once per tick.
  const pending = createMemo(() => pendingBar(props.chain, props.sinceLast));
  const height = (): JSX.CSSProperties | undefined => {
    const view = pending();
    return view.phase === 'searching' ? undefined : { height: `${String(view.heightPercent)}%` };
  };
  return (
    <>
      <span class={s['waiting']} data-testid="chains-bars-waiting">
        {pending().text}
      </span>
      <span class={s['trail']} style={{ '--slots': String(HISTORY_SLOTS) }}>
        <Stubs count={HISTORY_SLOTS - 1} />
        <span
          class={[s['bar'], s['pending']]}
          data-testid="chains-bar-pending"
          data-pending={pending().phase}
          style={height()}
        />
      </span>
    </>
  );
}

function Stubs(props: { count: number }): JSX.Element {
  const slots = createMemo(() => Array.from({ length: props.count }, (_, i) => i));
  return (
    <For each={slots()}>
      {slot => <span class={s['stub']} data-testid="chains-bar-stub" style={{ opacity: slotOpacity(slot) }} />}
    </For>
  );
}

/** Bars keep their element while on screen, so new ones slide in instead of the strip being rebuilt. */
function BarStrip(props: { chain: ChainSummary; sinceLast: number | null }): JSX.Element {
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
      aria-label={`${props.chain.label} recent blocks`}
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
                data-testid="chains-bar"
                data-block={block}
                class={s['bar']}
                data-health={bar.health}
                style={{ opacity: slotOpacity(HISTORY_SLOTS - visible().length + index()) }}
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
 * One chain: its name with its peers, or Not in use, over its recent blocks. Before a first block it shows a ghost bar
 * and an estimate, `sinceLast` ms after the chain's last block (null before any).
 */
export function ChainGroup(props: { chain: ChainSummary; sinceLast: number | null }): JSX.Element {
  // No chip rather than "0 peers" until a sample lands: zero is a different claim.
  const peers = createMemo(() =>
    props.chain.reachable && props.chain.peers !== null ? describePeers(props.chain.label, props.chain.peers) : null,
  );
  return (
    <Stack class={s['group']} testId="chains-group">
      <p class={s['groupLabel']} data-testid="chains-group-label" data-state={props.chain.state}>
        <span class={s['name']} data-testid="chains-group-name">
          {props.chain.label}
        </span>
        <Show
          when={props.chain.state !== 'unused' || !props.chain.reachable}
          fallback={
            <Chip tone="mono" testId="chains-group-unused">
              Not in use
            </Chip>
          }
        >
          <Show when={peers()}>
            {chip => (
              <Chip tone={chip().tone} testId="chains-group-peers" label={chip().label}>
                {chip().text}
              </Chip>
            )}
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
