// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

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

export const POLKAVM_VIEW_INSETS = "dotli:polkavm-view-insets";
export const POLKAVM_VIEW_INSETS_REQUEST = "dotli:polkavm-view-insets-request";

const ZERO_INSETS: ViewInsets = Object.freeze({
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
});

function physicalInset(
  value: number,
  extent: number,
  pixelRatio: number,
): number {
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
  viewport: ViewportMetrics | null,
  devicePixelRatio: number,
): ViewInsets {
  if (
    viewport === null ||
    !Number.isFinite(viewport.scale) ||
    Math.abs(viewport.scale - 1) > UNIT_SCALE_EPSILON
  ) {
    return ZERO_INSETS;
  }
  const ratio =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  const viewportRight = viewport.offsetLeft + viewport.width;
  const viewportBottom = viewport.offsetTop + viewport.height;
  return {
    left: physicalInset(viewport.offsetLeft - frame.left, frame.width, ratio),
    top: physicalInset(viewport.offsetTop - frame.top, frame.height, ratio),
    right: physicalInset(frame.right - viewportRight, frame.width, ratio),
    bottom: physicalInset(frame.bottom - viewportBottom, frame.height, ratio),
  };
}

/** Relay top-level visual-viewport occlusion to one authenticated product. */
export function installPolkaVmViewInsetsRelay(
  iframe: HTMLIFrameElement,
  targetOrigin: string,
): () => void {
  let lastKeyboard: ViewInsets | null = null;
  let scheduledFrame: number | null = null;
  const send = (force = false): void => {
    const target = iframe.contentWindow;
    if (target === null) {
      return;
    }
    const keyboard = keyboardInsetsForFrame(
      iframe.getBoundingClientRect(),
      window.visualViewport,
      window.devicePixelRatio,
    );
    if (
      !force &&
      lastKeyboard !== null &&
      keyboard.left === lastKeyboard.left &&
      keyboard.top === lastKeyboard.top &&
      keyboard.right === lastKeyboard.right &&
      keyboard.bottom === lastKeyboard.bottom
    ) {
      return;
    }
    lastKeyboard = keyboard;
    target.postMessage({ type: POLKAVM_VIEW_INSETS, keyboard }, targetOrigin);
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
      (event.data as { type?: unknown } | null)?.type !==
        POLKAVM_VIEW_INSETS_REQUEST
    ) {
      return;
    }
    send(true);
  };

  window.addEventListener("message", onMessage);
  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  iframe.addEventListener("load", onLoad);
  const observer =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  observer?.observe(iframe);

  return () => {
    if (scheduledFrame !== null) {
      window.cancelAnimationFrame(scheduledFrame);
    }
    observer?.disconnect();
    iframe.removeEventListener("load", onLoad);
    window.visualViewport?.removeEventListener("scroll", schedule);
    window.visualViewport?.removeEventListener("resize", schedule);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("message", onMessage);
  };
}
