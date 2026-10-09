// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Redraws when the recorder changes while visible, and on a tick, because a chain's open block must keep
// growing while the chain emits nothing. An unchanged model stops the redraw, so a finished load costs nothing.

import { createEffect, createSignal, flush, onCleanup, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { buildResolution, type ResolutionModel, type ResolutionRecorder } from '@dotli/truapi-debug';
import { wireHoverTooltips } from './hover-tooltip.js';
import { Chart } from './resolution/Chart.js';
import { Summary } from './resolution/Summary.js';
import s from './ResolutionView.module.css';

const RESOLUTION_TICK_MS = 500;

/** Every empty model looks the same on screen, whenever it was built. */
function drawnKey(model: ResolutionModel): string {
  return model.flowId === null ? '' : JSON.stringify(model);
}

export function ResolutionView(props: {
  active: boolean;
  collapsed: boolean;
  /** The recorder's version as of the last panel refresh. */
  refresh: number;
  recorder: ResolutionRecorder;
  tooltip: () => HTMLElement | undefined;
  panel: () => HTMLElement | undefined;
}): JSX.Element {
  const recorder = untrack(() => props.recorder);
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

  // The compute reads nothing that moves with traffic, since the effect re-runs on every compute change.
  createEffect(
    () => (props.active && !props.collapsed ? props.refresh : null),
    refresh => {
      if (refresh !== null) {
        draw();
      }
    },
  );

  // Only a running load grows with time. A new load arrives through the refresh effect.
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
