// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Bytes32 } from '@parity/truapi';
import type { PlacedContactLabels } from '@parity/truapi-host';
import { surfaceMapping, type AvatarSurfaceFit } from '../profile/avatar-overlay.js';
import s from './label-overlay.module.css';

/** Host-owned names are painted outside the product document, without profiles. */
export interface ContactLabelOverlay {
  readonly signal: AbortSignal;
  attach(frame: HTMLIFrameElement, fit: AvatarSurfaceFit): void;
  place(placed: PlacedContactLabels, names: ReadonlyMap<Bytes32, string>): void;
  clear(): void;
  dispose(): void;
}

interface LabelView {
  root: HTMLElement;
  text: HTMLElement;
  geometry: string;
}

export function createContactLabelOverlay(): ContactLabelOverlay {
  const layer = document.createElement('div');
  layer.className = s['overlay'] ?? '';
  layer.setAttribute('data-testid', 'contact-label-overlay');
  const views = new Map<number, LabelView>();
  let frame: HTMLIFrameElement | null = null;
  let fit: AvatarSurfaceFit = 'viewport';
  let placed: PlacedContactLabels | null = null;
  let names: ReadonlyMap<Bytes32, string> = new Map();
  let generation = new AbortController();
  let frameRequest: number | null = null;
  let settleTimer: number | null = null;
  let untrack: (() => void) | undefined;
  let disposed = false;

  const stopSettle = (): void => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  };
  const settle = (): void => {
    stopSettle();
    settleTimer = window.setTimeout(() => {
      settleTimer = null;
      for (const view of views.values()) {
        view.root.removeAttribute('data-moving');
      }
    }, 150);
  };
  const hideMoving = (): void => {
    for (const view of views.values()) {
      view.root.setAttribute('data-moving', '');
    }
    if (views.size !== 0) {
      settle();
    }
  };
  const clear = (): void => {
    if (disposed) {
      return;
    }
    generation.abort();
    generation = new AbortController();
    placed = null;
    names = new Map();
    if (frameRequest !== null) {
      cancelAnimationFrame(frameRequest);
      frameRequest = null;
    }
    stopSettle();
    views.clear();
    layer.replaceChildren();
    layer.remove();
  };
  const render = (): void => {
    if (disposed || frame === null || placed === null) {
      return;
    }
    const map = surfaceMapping(fit, placed.surfaceWidth, placed.surfaceHeight, frame.clientWidth, frame.clientHeight);
    const drawn = new Set<number>();
    let moved = false;
    for (const label of placed.labels) {
      const name = names.get(label.account);
      if (name === undefined) {
        continue;
      }
      const { rect, clip } = label;
      const x0 = Math.max(clip.x, rect.x, 0);
      const y0 = Math.max(clip.y, rect.y, 0);
      const x1 = Math.min(clip.x + clip.width, rect.x + rect.width, placed.surfaceWidth);
      const y1 = Math.min(clip.y + clip.height, rect.y + rect.height, placed.surfaceHeight);
      if (x1 <= x0 || y1 <= y0) {
        continue;
      }
      let view = views.get(label.slot);
      if (view === undefined) {
        const root = document.createElement('div');
        root.className = s['slot'] ?? '';
        const text = document.createElement('div');
        text.className = s['label'] ?? '';
        text.setAttribute('data-testid', 'contact-label');
        root.append(text);
        view = { root, text, geometry: '' };
        views.set(label.slot, view);
        layer.append(root);
      }
      drawn.add(label.slot);
      const x = map.offsetX + x0 * map.scaleX;
      const y = map.offsetY + y0 * map.scaleY;
      const width = (x1 - x0) * map.scaleX;
      const height = (y1 - y0) * map.scaleY;
      const textX = (rect.x - x0) * map.scaleX;
      const textY = (rect.y - y0) * map.scaleY;
      const textWidth = rect.width * map.scaleX;
      const textHeight = rect.height * map.scaleY;
      const geometry = `${String(x)},${String(y)},${String(width)},${String(height)},${String(textX)},${String(textY)},${String(textWidth)},${String(textHeight)}`;
      if (view.geometry !== geometry) {
        view.geometry = geometry;
        view.root.style.transform = `translate(${String(x)}px, ${String(y)}px)`;
        view.root.style.width = `${String(width)}px`;
        view.root.style.height = `${String(height)}px`;
        view.text.style.transform = `translate(${String(textX)}px, ${String(textY)}px)`;
        view.text.style.width = `${String(textWidth)}px`;
        view.text.style.height = `${String(textHeight)}px`;
        view.text.style.lineHeight = `${String(textHeight)}px`;
        view.text.style.fontSize = `${String(Math.min(13 * map.scaleY, textHeight))}px`;
        view.root.setAttribute('data-moving', '');
        moved = true;
      }
      const displayName = name === label.account ? `${label.account.slice(0, 8)}…${label.account.slice(-6)}` : name;
      if (view.text.textContent !== displayName) {
        view.text.textContent = displayName;
      }
      view.text.setAttribute('aria-label', name);
    }
    for (const [slot, view] of views) {
      if (!drawn.has(slot)) {
        view.root.remove();
        views.delete(slot);
      }
    }
    if (views.size === 0) {
      stopSettle();
      layer.remove();
    } else {
      if (moved) {
        settle();
      }
      if (layer.parentNode !== frame.parentNode) {
        frame.after(layer);
      }
    }
  };
  const schedule = (): void => {
    if (!disposed && frameRequest === null) {
      frameRequest = requestAnimationFrame(() => {
        frameRequest = null;
        render();
      });
    }
  };
  return {
    get signal() {
      return generation.signal;
    },
    attach(target, surfaceFit) {
      if (disposed) {
        return;
      }
      untrack?.();
      frame = target;
      fit = surfaceFit;
      const mirror = (): void => {
        layer.style.cssText = target.style.cssText;
        layer.style.pointerEvents = 'none';
        layer.style.overflow = 'hidden';
        hideMoving();
        schedule();
      };
      const resize = (): void => {
        hideMoving();
        schedule();
      };
      const styleObserver = new MutationObserver(mirror);
      styleObserver.observe(target, {
        attributes: true,
        attributeFilter: ['style'],
      });
      const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
      resizeObserver?.observe(target);
      window.addEventListener('resize', resize);
      // Navigation cannot leave names from the previous document painted over it.
      target.addEventListener('load', clear);
      untrack = () => {
        styleObserver.disconnect();
        resizeObserver?.disconnect();
        window.removeEventListener('resize', resize);
        target.removeEventListener('load', clear);
      };
      mirror();
    },
    place(next, nextNames) {
      if (disposed) {
        return;
      }
      if (next.labels.length === 0) {
        clear();
        return;
      }
      placed = next;
      names = nextNames;
      schedule();
    },
    clear,
    dispose() {
      if (!disposed) {
        untrack?.();
        clear();
        disposed = true;
        generation.abort();
        frame = null;
      }
    },
  };
}
