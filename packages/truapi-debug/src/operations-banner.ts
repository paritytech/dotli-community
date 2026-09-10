// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Live-operations banner.
//
// A floating card pinned to the top-right corner listing what the host is
// doing right now, one row per flow, each row a stack of steps. The web
// counterpart of the iOS `StallBannerWindow`, reveal latch included: a flow
// only appears once it has been open for `DEFAULT_REVEAL_AFTER_MS`.
//
// Crossing that threshold is the passage of time, not an event, so while any
// flow is still under it the banner re-evaluates on a one-second tick. The
// tick stops as soon as nothing is waiting, matching `StallBoard.updateTick`.
//
// Clicks fall through everywhere except the card itself, so the product below
// stays usable while the banner is up.
//
// Mounted and torn down by `setupTruapiDebugPanel`, so it is on exactly when
// the debug panel is.

import { escapeHtml } from "@dotli/shared/html";
import type { EventStore } from "./event-store.ts";
import {
  buildOperations,
  DEFAULT_MAX_VISIBLE,
  type Operation,
  type OperationStep,
} from "./operations.ts";

const BANNER_ID = "truapi-ops-banner";
const TICK_MS = 1000;

interface BannerState {
  dismissed: Set<string>;
  expanded: boolean;
}

/**
 * Install the operations banner, reading from an already-populated store.
 *
 * Returns a dispose function that removes the DOM and drops every
 * subscription. Calling twice without disposing is a no-op on the second
 * call.
 */
export function setupOperationsBanner(store: EventStore): () => void {
  if (document.getElementById(BANNER_ID) !== null) {
    return () => {
      /* already mounted; owner should dispose the original handle */
    };
  }

  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.className = "td-ops hidden";
  document.body.appendChild(banner);

  const state: BannerState = { dismissed: new Set(), expanded: false };

  let renderScheduled = false;
  const scheduleRender = (): void => {
    if (renderScheduled) {
      return;
    }
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      setTicking(render(banner, store, state));
    });
  };

  banner.addEventListener("click", (event) => {
    if (!(event.target instanceof HTMLElement)) {
      return;
    }
    const dismiss = event.target.closest<HTMLElement>(".td-ops-dismiss");
    if (dismiss !== null) {
      const id = dismiss.dataset.opId;
      if (id !== undefined) {
        state.dismissed.add(id);
        scheduleRender();
      }
      return;
    }
    if (event.target.closest(".td-ops-overflow") !== null) {
      state.expanded = !state.expanded;
      scheduleRender();
    }
  });

  let tick: ReturnType<typeof setInterval> | null = null;
  const setTicking = (ticking: boolean): void => {
    if (ticking === (tick !== null)) {
      return;
    }
    if (ticking) {
      tick = setInterval(scheduleRender, TICK_MS);
    } else if (tick !== null) {
      clearInterval(tick);
      tick = null;
    }
  };

  const unsubscribeStore = store.subscribe(scheduleRender);
  window.addEventListener("resize", scheduleRender);

  // The banner sits clear of the panel when the panel is docked right, so it
  // has to reposition when the dock changes. A width change on the panel is
  // the one signal that covers both dock toggles and drag-resize.
  const panel = document.getElementById("truapi-debug-panel");
  let panelResize: ResizeObserver | null = null;
  if (panel !== null) {
    panelResize = new ResizeObserver(() => {
      scheduleRender();
    });
    panelResize.observe(panel);
  }

  setTicking(render(banner, store, state));

  return () => {
    setTicking(false);
    panelResize?.disconnect();
    window.removeEventListener("resize", scheduleRender);
    unsubscribeStore();
    banner.remove();
  };
}

/** Renders the banner and reports whether any flow is still waiting to cross
 *  the reveal threshold, which is what decides if the tick keeps running. */
function render(
  banner: HTMLElement,
  store: EventStore,
  state: BannerState,
): boolean {
  const snapshot = buildOperations(store.list(), {
    dismissed: state.dismissed,
    maxVisible: state.expanded ? Number.POSITIVE_INFINITY : DEFAULT_MAX_VISIBLE,
    now: Date.now(),
  });

  if (snapshot.operations.length === 0) {
    banner.classList.add("hidden");
    banner.innerHTML = "";
    return snapshot.pending > 0;
  }

  position(banner);
  banner.classList.remove("hidden");

  const rows = snapshot.operations.map(renderOperation).join("");
  const overflow =
    snapshot.hiddenCount > 0
      ? `<button class="td-ops-overflow" type="button">+${String(snapshot.hiddenCount)} more</button>`
      : state.expanded
        ? `<button class="td-ops-overflow" type="button">show less</button>`
        : "";

  banner.innerHTML = `<div class="td-ops-card">${rows}${overflow}</div>`;
  return snapshot.pending > 0;
}

/** Keep the card under the top bar and clear of a right-docked panel. */
function position(banner: HTMLElement): void {
  const topbar = document.getElementById("topbar");
  banner.style.top =
    topbar === null ? "12px" : `${String(topbar.offsetHeight + 12)}px`;

  const panel = document.getElementById("truapi-debug-panel");
  const dockedRight =
    panel !== null &&
    panel.classList.contains("docked-right") &&
    !panel.classList.contains("collapsed");
  banner.style.right = dockedRight
    ? `${String(panel.offsetWidth + 12)}px`
    : "12px";
}

function renderOperation(operation: Operation): string {
  const steps = operation.steps.map(renderStep).join("");
  return `
    <div class="td-ops-op">
      <div class="td-ops-head">
        <span class="td-layer-badge td-layer-${escapeHtml(operation.layer)}">${escapeHtml(operation.layer)}</span>
        <span class="td-ops-title" title="${escapeHtml(operation.title)}">${escapeHtml(operation.title)}</span>
        <button class="td-ops-dismiss" type="button" data-op-id="${escapeHtml(operation.id)}" title="Dismiss" aria-label="Dismiss">×</button>
      </div>
      <div class="td-ops-steps">${steps}</div>
    </div>`;
}

function renderStep(step: OperationStep): string {
  const detail =
    step.detail === null
      ? ""
      : `<span class="td-ops-detail">${escapeHtml(step.detail)}</span>`;
  return `
    <div class="td-ops-step td-ops-${step.state}">
      <span class="td-ops-indicator"></span>
      <span class="td-ops-step-body">
        <span class="td-ops-step-title">${escapeHtml(step.title)}</span>
        ${detail}
      </span>
    </div>`;
}
