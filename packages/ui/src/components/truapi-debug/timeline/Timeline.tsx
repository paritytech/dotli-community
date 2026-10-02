// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The Timeline: one column per swimlane, each a sticky header over an SVG of
// rails, lifecycle ticks and request/response boxes, drawn from the geometry
// `buildTimeline` makes.
//
// Lanes are keyed by lane key, and rails, ticks and boxes by their seq. So as
// events stream in, a redraw moves, resizes and recolours the nodes already
// there: the box under the cursor stays the same node, its hover and tooltip
// stay up, and a click that started on it still lands on it.
//
// The selection is reactive: the box that holds the selected seq carries
// `data-selected`. A click on a rail, tick or box hands its seq to `onSelect`.

import { createMemo, For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { EventSeq, TimelineLane } from '@dotli/truapi-debug';
import s from './Timeline.module.css';

export type TimelineSelect = (seq: EventSeq, el: Element) => void;

export function Timeline(props: {
  lanes: readonly TimelineLane[];
  selectedSeq: EventSeq | null;
  onSelect: TimelineSelect;
}): JSX.Element {
  return (
    <div class={s['row']} data-testid="td-sw-row">
      <For each={props.lanes} keyed={lane => lane.key}>
        {lane => <Lane lane={lane()} selectedSeq={props.selectedSeq} onSelect={props.onSelect} />}
      </For>
    </div>
  );
}

function Lane(props: { lane: TimelineLane; selectedSeq: EventSeq | null; onSelect: TimelineSelect }): JSX.Element {
  // The key of the box that holds the selected seq. Each box compares its own
  // key with it, so a new selection reruns one scan, not one per box.
  const selectedKey = createMemo((): EventSeq | null => {
    const seq = props.selectedSeq;
    return seq === null ? null : (props.lane.boxes.find(b => b.memberSeqs.includes(seq))?.key ?? null);
  });
  const viewBox = (): string => `0 0 ${String(props.lane.width)} ${String(props.lane.height)}`;
  return (
    <div class={s['col']} data-testid="td-sw-col">
      <div class={s['header']} data-testid="td-sw-header" style={{ '--lane-accent': props.lane.color }}>
        <span class={s['label']} data-testid="td-sw-header-label">
          {props.lane.header}
        </span>
      </div>
      <div class={s['body']}>
        <svg
          class={s['svg']}
          data-testid="td-tl-svg"
          xmlns="http://www.w3.org/2000/svg"
          width={props.lane.width}
          height={props.lane.height}
          viewBox={viewBox()}
        >
          <line class={s['divider']} x1={props.lane.marginX} y1={0} x2={props.lane.marginX} y2={props.lane.height} />
          <Show when={props.lane.railsEndX}>
            {x => <line class={s['divider']} x1={x()} y1={0} x2={x()} y2={props.lane.height} />}
          </Show>
          <For each={props.lane.rails} keyed={rail => rail.key}>
            {rail => (
              <line
                class={s['rail']}
                data-testid="td-tl-rail"
                data-kind="rail"
                data-seq={rail().seq}
                data-tooltip={rail().tooltip}
                x1={rail().x}
                y1={rail().y1}
                x2={rail().x}
                y2={rail().y2}
                stroke={rail().color}
                stroke-dasharray={rail().pending ? '2 3' : undefined}
                onClick={e => {
                  props.onSelect(rail().seq, e.currentTarget);
                }}
              />
            )}
          </For>
          <For each={props.lane.ticks} keyed={tick => tick.key}>
            {tick => (
              <circle
                class={s['tick']}
                data-testid="td-tl-tick"
                data-kind="tick"
                data-seq={tick().seq}
                data-tooltip={tick().tooltip}
                cx={tick().cx}
                cy={tick().cy}
                r={2}
                fill={tick().color}
                onClick={e => {
                  props.onSelect(tick().seq, e.currentTarget);
                }}
              />
            )}
          </For>
          <For each={props.lane.boxes} keyed={box => box.key}>
            {box => (
              <>
                <rect
                  class={s['segment']}
                  data-testid="td-tl-segment"
                  data-kind="segment"
                  data-seq={box().seq}
                  data-tooltip={box().tooltip}
                  data-pending={box().pending ? '' : undefined}
                  data-selected={selectedKey() === box().key ? '' : undefined}
                  x={box().x}
                  y={box().y}
                  width={box().width}
                  height={box().height}
                  rx={2}
                  ry={2}
                  fill={box().color}
                  onClick={e => {
                    props.onSelect(box().seq, e.currentTarget);
                  }}
                />
                <Show when={box().connector}>
                  {c => (
                    <line class={s['connector']} x1={c().x1} y1={c().y} x2={c().x2} y2={c().y} stroke={box().color} />
                  )}
                </Show>
                <Show when={box().pendingEdge}>
                  {edge => <line class={s['pendingEdge']} x1={edge().x1} y1={edge().y} x2={edge().x2} y2={edge().y} />}
                </Show>
              </>
            )}
          </For>
        </svg>
      </div>
    </div>
  );
}
