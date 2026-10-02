// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Resolution view of the TrUAPI debug panel.
//
// Draws the model `buildResolution` makes from the recorder. This component
// decides when to redraw: when the recorder changes while visible (not on
// TrUAPI traffic, which it does not record), and on a tick, because the
// block a chain is still sitting in has to keep growing toward now while a
// chain that has gone quiet emits nothing to redraw on.
//
// A redraw that builds the same model as the last one stops there, so a
// finished load costs nothing to redraw. A changed model reaches components
// keyed by fact, chain role and position, which rewrite only the values that
// moved. A node the cursor is on stays put, and so does its tooltip.

import { createEffect, createSignal, flush, onCleanup, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { buildResolution, type ResolutionModel, type ResolutionRecorder } from '@dotli/truapi-debug';
import { wireHoverTooltips } from './hover-tooltip.js';
import { Chart } from './resolution/Chart.js';
import { Summary } from './resolution/Summary.js';
import s from './ResolutionView.module.css';

/** How often the Resolution view redraws the open block of an in-flight load. */
const RESOLUTION_TICK_MS = 500;

/** What a redraw compares against the last one. Every empty model looks the
 *  same on screen, whatever moment it was built at. */
function drawnKey(model: ResolutionModel): string {
  return model.flowId === null ? '' : JSON.stringify(model);
}

export function ResolutionView(props: {
  active: boolean;
  collapsed: boolean;
  /** The recorder's version as of the last panel refresh; a change redraws
   *  while on screen. */
  refresh: number;
  recorder: ResolutionRecorder;
  tooltip: () => HTMLElement | undefined;
  panel: () => HTMLElement | undefined;
}): JSX.Element {
  const recorder = untrack(() => props.recorder);
  // Null until the first draw, which leaves the view empty.
  const [model, setModel] = createSignal<ResolutionModel | null>(null, {
    // Written from the redraw effect below.
    ownedWrite: true,
  });
  let drawn: string | null = null;
  const draw = (): void => {
    const next = buildResolution(recorder.events(), Date.now());
    const key = drawnKey(next);
    if (key === drawn) {
      return;
    }
    drawn = key;
    setModel(next);
  };

  // Re-runs only when one of these changes: an effect's function runs on
  // every compute, so the compute reads nothing that moves with traffic.
  createEffect(
    () => (props.active && !props.collapsed ? props.refresh : null),
    refresh => {
      if (refresh !== null) {
        draw();
      }
    },
  );

  // A collapsed panel is not on screen, so it redraws nothing. Outside
  // Solid's update pass, so it applies its write at once, as the effect's
  // does.
  // Only a load still running grows with time, so a finished or empty one
  // skips the rebuild; a new load arrives through the refresh effect.
  const tick = window.setInterval(() => {
    if (props.active && !props.collapsed && model()?.summary.outcome === 'running') {
      flush(draw);
    }
  }, RESOLUTION_TICK_MS);

  let unwireTooltips: (() => void) | undefined;
  onCleanup(() => {
    window.clearInterval(tick);
    unwireTooltips?.();
  });

  return (
    <div
      class={s['res']}
      data-testid="td-res"
      hidden={!props.active}
      ref={el => {
        unwireTooltips = wireHoverTooltips(
          el,
          untrack(() => props.tooltip),
          untrack(() => props.panel),
        );
      }}
    >
      <Show when={model()}>
        {m => (
          <Show
            when={m().flowId !== null}
            fallback={
              <div class={s['empty']} data-testid="td-res-empty">
                No page load recorded yet. Reload the page with the panel open.
              </div>
            }
          >
            <Summary model={m()} />
            <Show when={m().summary.backend !== 'rpc-gateway'}>
              <Chart model={m()} />
            </Show>
          </Show>
        )}
      </Show>
    </div>
  );
}
