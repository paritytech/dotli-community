// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The Resolution chart: one row per chain role, each a run of phase blocks on
// a time axis shared by every row.
//
// Rows are keyed by role, and blocks and ticks by position (a row only ever
// gains blocks at its end, and the axis always has the same ticks). So while
// a load is in flight a redraw moves and relabels the nodes already there,
// and a block keeps its node, and its native `title` tooltip, as it grows.

import { createMemo, For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ResolutionModel, ResolutionRow } from '@dotli/truapi-debug';
import { axisTicks, blockView, rowMeta } from './format.js';
import s from './Chart.module.css';

export function Chart(props: { model: ResolutionModel }): JSX.Element {
  const span = (): number => Math.max(1, props.model.elapsedMs);
  const running = (): boolean => props.model.summary.outcome === 'running';
  const ticks = createMemo(() => axisTicks(span()));
  return (
    <div data-testid="td-res-chart">
      <div class={s['row']} data-axis="">
        <span class={s['name']} />
        <div class={s['track']} data-testid="td-res-axis" data-axis="">
          <For each={ticks()} keyed={false}>
            {tick => (
              <span class={s['tick']} data-testid="td-res-tick" style={{ left: tick().left }}>
                {tick().label}
              </span>
            )}
          </For>
        </div>
        <span class={s['meta']} />
      </div>
      <For each={props.model.rows} keyed={row => row.role}>
        {row => <ChartRow row={row()} span={span()} running={running()} />}
      </For>
    </div>
  );
}

function ChartRow(props: { row: ResolutionRow; span: number; running: boolean }): JSX.Element {
  const blocks = createMemo(() => {
    const last = props.row.blocks.length - 1;
    return props.row.blocks.map((b, i) => blockView(b, props.running && i === last, props.span));
  });
  return (
    <div class={s['row']} data-testid="td-res-row" data-role={props.row.role}>
      <span class={s['name']}>{props.row.label}</span>
      <div class={s['track']}>
        <Show
          when={props.row.blocks.length > 0}
          fallback={
            <span class={s['idle']} data-testid="td-res-idle">
              never started. This chain was not needed, or the load ended first
            </span>
          }
        >
          <For each={blocks()} keyed={false}>
            {block => (
              <div
                class={s['block']}
                data-testid="td-res-block"
                data-phase={block().tone}
                data-open={block().open ? '' : undefined}
                style={{ left: block().left, width: block().width }}
                title={block().title}
              >
                <span class={s['label']}>{block().phase}</span>
              </div>
            )}
          </For>
        </Show>
      </div>
      <span class={s['meta']} data-testid="td-res-meta">
        {rowMeta(props.row)}
      </span>
    </div>
  );
}
