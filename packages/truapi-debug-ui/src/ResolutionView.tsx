// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Redraws when the recorder changes while visible, and on a tick, because a chain's open block must keep
// growing while the chain emits nothing. An unchanged model stops the redraw, so a finished load costs nothing.

import { createEffect, createSignal, flush, onCleanup, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ResolutionModel } from './model/buildResolution.js';
import type { ResolutionRecorder } from './model/createResolutionRecorder.js';
import { wireHoverTooltips } from './shared/wireHoverTooltips.js';
import { Chart } from './resolution/Chart.js';
import { Button } from './shared/Button.js';
import { EmptyState } from './shared/EmptyState.js';
import { Pane } from './shared/Pane.js';
import { Summary } from './resolution/Summary.js';
import { usePanelWork } from './panelWork.js';
import s from './ResolutionView.module.css';

const RESOLUTION_TICK_MS = 500;

export function ResolutionView(props: {
  active: boolean;
  collapsed: boolean;
  /** The recorder's version as of the last panel refresh. */
  refresh: number;
  recorder: ResolutionRecorder;
  tooltip: () => HTMLElement | undefined;
  panel: () => HTMLElement | undefined;
  onClear: () => void;
}): JSX.Element {
  const recorder = untrack(() => props.recorder);
  const { buildResolution } = usePanelWork();
  const [model, setModel] = createSignal<ResolutionModel | null>(null, {
    // Written from the redraw effect below.
    ownedWrite: true,
  });
  let drawn: string | null = null;
  function draw(): void {
    const next = buildResolution(recorder.events(), Date.now());
    const key = getDrawnKey(next);
    if (key === drawn) {
      return;
    }
    drawn = key;
    setModel(next);
  }

  // The compute reads nothing that moves with traffic, since the effect re-runs on every compute change.
  createEffect(
    () => (props.active && !props.collapsed ? props.refresh : null),
    refresh => {
      if (refresh !== null) {
        draw();
      }
    },
  );

  // Only a running load grows with time, and only a shown one needs redrawing. A new load arrives through the refresh
  // effect. The empty model also reads as running, so the clock waits for a recorded load.
  createEffect(
    () => {
      const shown = model();
      return (
        props.active &&
        !props.collapsed &&
        shown !== null &&
        shown.flowId !== null &&
        shown.summary.outcome === 'running'
      );
    },
    running => {
      if (!running) {
        return;
      }
      const tick = window.setInterval(() => {
        flush(draw);
      }, RESOLUTION_TICK_MS);
      return () => {
        window.clearInterval(tick);
      };
    },
  );

  let disposeTooltips: (() => void) | undefined;
  onCleanup(() => {
    disposeTooltips?.();
  });

  return (
    <Pane
      testId="td-res"
      label="Resolution"
      hidden={!props.active}
      padded
      class={s['res']}
      ref={element => {
        disposeTooltips = wireHoverTooltips({
          root: element,
          tooltip: untrack(() => props.tooltip),
          panel: untrack(() => props.panel),
        });
      }}
    >
      <div class={s['actions']}>
        <Button testId="td-res-clear" onClick={props.onClear}>
          Clear
        </Button>
      </div>
      <Show when={model()}>
        {shown => (
          <Show
            when={shown().flowId !== null}
            fallback={
              <EmptyState testId="td-res-empty">
                No page load recorded yet. Reload the page with the panel open.
              </EmptyState>
            }
          >
            <Summary model={shown()} />
            <Show when={shown().summary.backend !== 'rpc-gateway'}>
              <Chart model={shown()} />
            </Show>
          </Show>
        )}
      </Show>
    </Pane>
  );
}

/** Every empty model looks the same on screen, whenever it was built. */
function getDrawnKey(model: ResolutionModel): string {
  return model.flowId === null ? '' : JSON.stringify(model);
}
