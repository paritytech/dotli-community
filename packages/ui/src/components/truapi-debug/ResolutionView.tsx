// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Resolution view of the TrUAPI debug panel.
//
// Drawn by `@dotli/truapi-debug/resolution-view`, which memoizes its HTML so a
// finished load costs nothing to redraw. This component owns the container
// and decides when to redraw: on every panel refresh while visible, and on a
// tick, because the block a chain is still sitting in has to keep growing
// toward now while a chain that has gone quiet emits nothing to redraw on.

import { createEffect, onCleanup, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  buildResolution,
  buildResolutionContainer,
  renderResolution,
  type ResolutionRecorder,
} from "@dotli/truapi-debug/resolution-view";
import { wireHoverTooltips } from "./hover-tooltip";

/** How often the Resolution view redraws the open block of an in-flight load. */
const RESOLUTION_TICK_MS = 500;

export function ResolutionView(props: {
  active: boolean;
  collapsed: boolean;
  /** Changes on every panel refresh; redraws while active. */
  refresh: unknown;
  recorder: ResolutionRecorder;
  tooltip: () => HTMLElement | undefined;
  panel: () => HTMLElement | undefined;
}): JSX.Element {
  const { container } = buildResolutionContainer();
  const recorder = untrack(() => props.recorder);
  const draw = (): void => {
    renderResolution(container, buildResolution(recorder.events(), Date.now()));
  };

  createEffect(
    () => props.active,
    (active) => {
      container.classList.toggle("hidden", !active);
    },
  );

  createEffect(
    () => (props.active ? [props.refresh] : null),
    (refresh) => {
      if (refresh !== null) {
        draw();
      }
    },
  );

  // A collapsed panel is not on screen, so it redraws nothing.
  const tick = window.setInterval(() => {
    if (props.active && !props.collapsed) {
      draw();
    }
  }, RESOLUTION_TICK_MS);

  const unwireTooltips = wireHoverTooltips(
    container,
    untrack(() => props.tooltip),
    untrack(() => props.panel),
  );
  onCleanup(() => {
    window.clearInterval(tick);
    unwireTooltips();
  });

  return container;
}
