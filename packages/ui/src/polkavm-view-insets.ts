// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { productIframeBox } from './product-iframe-box.js';
import { topbarStore } from './state/topbar.js';

const MAX_INSET_PIXELS = 65_535;
const UNIT_SCALE_EPSILON = 0.01;

export interface ViewInsets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ViewportMetrics {
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
  scale: number;
}

export interface FrameRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export const POLKAVM_VIEW_INSETS = 'dotli:polkavm-view-insets';
export const POLKAVM_VIEW_INSETS_REQUEST = 'dotli:polkavm-view-insets-request';

const ZERO_INSETS: ViewInsets = Object.freeze({
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
});

function physicalInset(value: number, extent: number, pixelRatio: number): number {
  const bounded = Math.min(Math.max(value, 0), Math.max(extent, 0));
  return Math.min(MAX_INSET_PIXELS, Math.round(bounded * pixelRatio));
}

/**
 * Return the part of a product frame hidden outside the top-level visual
 * viewport. The host already places the frame inside the OS safe rectangle, so
 * these are residual keyboard/browser-widget insets rather than safe-area
 * insets. Pinch zoom deliberately returns zero: zoomed users pan the visual
 * viewport and must not cause the application to reflow beneath them.
 */
export function keyboardInsetsForFrame(
  frame: FrameRect,
  viewport: ViewportMetrics | null | undefined,
  devicePixelRatio: number,
): ViewInsets {
  if (
    viewport === null ||
    viewport === undefined ||
    !Number.isFinite(viewport.scale) ||
    Math.abs(viewport.scale - 1) > UNIT_SCALE_EPSILON
  ) {
    return ZERO_INSETS;
  }
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const viewportRight = viewport.offsetLeft + viewport.width;
  const viewportBottom = viewport.offsetTop + viewport.height;
  return {
    left: physicalInset(viewport.offsetLeft - frame.left, frame.width, ratio),
    top: physicalInset(viewport.offsetTop - frame.top, frame.height, ratio),
    right: physicalInset(frame.right - viewportRight, frame.width, ratio),
    bottom: physicalInset(frame.bottom - viewportBottom, frame.height, ratio),
  };
}

/** Only reserve safe/content edges that the host has not already excluded from the frame. */
export function safeAreaInsetsForFrame(frame: FrameRect, content: FrameRect, devicePixelRatio: number): ViewInsets {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return {
    left: physicalInset(content.left - frame.left, frame.width, ratio),
    top: physicalInset(content.top - frame.top, frame.height, ratio),
    right: physicalInset(frame.right - content.right, frame.width, ratio),
    bottom: physicalInset(frame.bottom - content.bottom, frame.height, ratio),
  };
}

/** Relay host safe-area and visual-viewport occlusion to one authenticated product. */
export function installPolkaVmViewInsetsRelay(iframe: HTMLIFrameElement, targetOrigin: string): () => void {
  // Resolve the same calc/env expressions as frame layout without moving the
  // product. Reserve the expanded band even while the floating bar is folded.
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.inert = true;
  Object.assign(probe.style, {
    position: 'fixed',
    visibility: 'hidden',
    pointerEvents: 'none',
  });
  let topbarOffset: boolean | null = null;
  const updateProbe = (): void => {
    const state = topbarStore.get();
    const reserve = state.present && !state.landing;
    if (reserve === topbarOffset) {
      return;
    }
    topbarOffset = reserve;
    Object.assign(probe.style, productIframeBox({ topbarOffset: reserve }));
  };
  updateProbe();
  document.body.appendChild(probe);
  const viewport = window.visualViewport;
  let lastSafeArea: ViewInsets | null = null;
  let lastKeyboard: ViewInsets | null = null;
  let lastPixelRatio: number | null = null;
  let scheduledFrame: number | null = null;
  const send = (force = false): void => {
    const target = iframe.contentWindow;
    if (target === null) {
      return;
    }
    const frame = iframe.getBoundingClientRect();
    const pixelRatio =
      Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const safeArea = safeAreaInsetsForFrame(frame, probe.getBoundingClientRect(), pixelRatio);
    const keyboard = keyboardInsetsForFrame(frame, viewport, pixelRatio);
    if (
      !force &&
      lastPixelRatio === pixelRatio &&
      lastSafeArea !== null &&
      lastKeyboard !== null &&
      safeArea.left === lastSafeArea.left &&
      safeArea.top === lastSafeArea.top &&
      safeArea.right === lastSafeArea.right &&
      safeArea.bottom === lastSafeArea.bottom &&
      keyboard.left === lastKeyboard.left &&
      keyboard.top === lastKeyboard.top &&
      keyboard.right === lastKeyboard.right &&
      keyboard.bottom === lastKeyboard.bottom
    ) {
      return;
    }
    lastSafeArea = safeArea;
    lastKeyboard = keyboard;
    lastPixelRatio = pixelRatio;
    target.postMessage({ type: POLKAVM_VIEW_INSETS, safeArea, keyboard }, targetOrigin);
  };
  const schedule = (): void => {
    if (scheduledFrame !== null) {
      return;
    }
    scheduledFrame = window.requestAnimationFrame(() => {
      scheduledFrame = null;
      send();
    });
  };
  const onLoad = (): void => {
    send(true);
  };
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (
      event.source !== iframe.contentWindow ||
      event.origin !== targetOrigin ||
      (event.data as { type?: unknown } | null)?.type !== POLKAVM_VIEW_INSETS_REQUEST
    ) {
      return;
    }
    send(true);
  };

  const unsubscribeTopbar = topbarStore.subscribe(() => {
    updateProbe();
    schedule();
  });
  // Moving between screens can change physical units without resizing CSS pixels.
  let resolution: MediaQueryList | null = null;
  const watchResolution = (): void => {
    resolution?.removeEventListener('change', onResolutionChange);
    resolution = window.matchMedia(`(resolution: ${String(window.devicePixelRatio)}dppx)`);
    resolution.addEventListener('change', onResolutionChange);
  };
  const onResolutionChange = (): void => {
    watchResolution();
    schedule();
  };
  watchResolution();
  window.addEventListener('message', onMessage);
  window.addEventListener('resize', schedule);
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  iframe.addEventListener('load', onLoad);
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  observer?.observe(iframe);
  observer?.observe(probe);

  return () => {
    if (scheduledFrame !== null) {
      window.cancelAnimationFrame(scheduledFrame);
    }
    observer?.disconnect();
    unsubscribeTopbar();
    resolution?.removeEventListener('change', onResolutionChange);
    probe.remove();
    iframe.removeEventListener('load', onLoad);
    viewport?.removeEventListener('scroll', schedule);
    viewport?.removeEventListener('resize', schedule);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('message', onMessage);
  };
}
