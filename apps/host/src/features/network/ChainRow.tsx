// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, createUniqueId, For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { prefersReducedMotion } from '@dotli/ui';
import { ChevronDownIcon } from '@dotli/ui/icons';
import { isWatched, type ChainSummary } from './chain.js';
import type { ChainView } from './chains.js';
import { describeChainHealth, type ChainHealthFacts } from './chainHealth.js';
import { pickChainGlyph } from './chainGlyph.js';
import { ChainHealthMark } from './ChainHealthMark.js';
import {
  describeBlockDelay,
  describePeers,
  HISTORY_SLOTS,
  landedBars,
  sameBars,
  slotOpacity,
  type PendingBarView,
} from './chainStrip.js';
import s from './ChainRow.module.css';

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
      // An unreachable chain draws none of its old bars, so they never read as current.
      const list = props.chain.reachable ? props.chain.bars : [];
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
        when={props.pending}
        fallback={
          <>
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
          </>
        }
      >
        {view => <PendingBar pending={view()} />}
      </Show>
    </div>
  );
}

/**
 * One chain as a row: its glyph in its health mark, its name and its status line, in a button that opens the chain's
 * recent blocks beneath it. `facts` are what the popover knows beside the chain, such as the time since its read.
 */
export function ChainRow(props: { chain: ChainView; facts: ChainHealthFacts }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const detailId = createUniqueId();
  const health = createMemo(() => describeChainHealth(props.chain, props.facts));
  // No caption rather than "0 peers" until a sample lands: zero is a different claim.
  const peers = createMemo(() =>
    isWatched(props.chain) && props.chain.peers !== null ? describePeers(props.chain.label, props.chain.peers) : null,
  );
  const newest = (): string | null => {
    const bar = props.chain.bars.at(-1);
    return bar === undefined ? null : `#${bar.number.toLocaleString('en-US')}`;
  };
  return (
    <div class={s['row']} data-testid="chains-row" data-mark={health().mark.kind}>
      <button
        type="button"
        class={s['head']}
        data-testid="chains-row-head"
        aria-expanded={open() ? 'true' : 'false'}
        aria-controls={detailId}
        onClick={() => setOpen(!open())}
      >
        <ChainHealthMark mark={health().mark} glyph={pickChainGlyph(props.chain.role)} />
        <span class={s['text']}>
          <span class={s['name']} data-testid="chains-row-name">
            {props.chain.label}
          </span>
          <span class={s['status']} data-testid="chains-row-status" data-tone={health().status.tone ?? undefined}>
            {health().status.text}
          </span>
        </span>
        <ChevronDownIcon class={s['chevron']} />
      </button>
      <Show when={open()}>
        <div id={detailId} class={s['detail']} data-testid="chains-row-detail">
          <p class={s['line']}>
            <span>
              {`Last ${String(HISTORY_SLOTS)} blocks`}
              <Show when={peers()}>
                {count => (
                  <>
                    {' · '}
                    <span
                      class={s['peers']}
                      data-tone={count().tone === 'warn' ? 'warn' : undefined}
                      data-testid="chains-row-peers"
                      title={count().label}
                    >
                      {count().text}
                    </span>
                  </>
                )}
              </Show>
            </span>
            <Show when={newest()}>
              {block => (
                <span class={s['block']} data-testid="chains-row-block">
                  {block()}
                </span>
              )}
            </Show>
          </p>
          <div class={s['cell']} data-testid="chains-cell" data-state={props.chain.state}>
            <BarStrip chain={props.chain} pending={health().pending} />
          </div>
        </div>
      </Show>
    </div>
  );
}
