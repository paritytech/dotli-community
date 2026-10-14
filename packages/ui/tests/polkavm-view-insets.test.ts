// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installPolkaVmViewInsetsRelay,
  keyboardInsetsForFrame,
  safeAreaInsetsForFrame,
  POLKAVM_VIEW_INSETS,
  POLKAVM_VIEW_INSETS_REQUEST,
} from '../src/polkavm-view-insets.js';
import { productIframeBox } from '../src/product-iframe-box.js';
import { topbarStore } from '../src/state/topbar.js';

const zeroInsets = { left: 0, top: 0, right: 0, bottom: 0 };
const fullFrame = { left: 0, top: 0, right: 400, bottom: 800, width: 400, height: 800 };
const desktopContent = { ...fullFrame, top: 68, height: 732 };

const frame = {
  left: 0,
  top: 56,
  right: 390,
  bottom: 844,
  width: 390,
  height: 788,
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('PolkaVM visual viewport insets', () => {
  it('reports no residual inset when the product is fully visible', () => {
    expect(
      keyboardInsetsForFrame(
        frame,
        {
          offsetLeft: 0,
          offsetTop: 0,
          width: 390,
          height: 844,
          scale: 1,
        },
        3,
      ),
    ).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  it('reports keyboard overlap in physical pixels', () => {
    expect(
      keyboardInsetsForFrame(
        frame,
        {
          offsetLeft: 0,
          offsetTop: 0,
          width: 390,
          height: 600,
          scale: 1,
        },
        3,
      ),
    ).toEqual({ left: 0, top: 0, right: 0, bottom: 732 });
  });

  it('does not double count a layout viewport already resized above the keyboard', () => {
    expect(
      keyboardInsetsForFrame(
        { ...frame, bottom: 600, height: 544 },
        {
          offsetLeft: 0,
          offsetTop: 0,
          width: 390,
          height: 600,
          scale: 1,
        },
        3,
      ),
    ).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  it('maps every residual visual viewport edge to the product frame', () => {
    expect(
      keyboardInsetsForFrame(
        { left: 0, top: 0, right: 400, bottom: 800, width: 400, height: 800 },
        {
          offsetLeft: 10,
          offsetTop: 40,
          width: 380,
          height: 600,
          scale: 1,
        },
        2,
      ),
    ).toEqual({ left: 20, top: 80, right: 20, bottom: 320 });
  });

  it('does not reinterpret pinch zoom as application occlusion', () => {
    expect(
      keyboardInsetsForFrame(
        frame,
        {
          offsetLeft: 40,
          offsetTop: 100,
          width: 195,
          height: 422,
          scale: 2,
        },
        3,
      ),
    ).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  it('clamps values to the guest input record limit', () => {
    expect(
      keyboardInsetsForFrame(
        {
          left: 0,
          top: 0,
          right: 400,
          bottom: 20_000,
          width: 400,
          height: 20_000,
        },
        {
          offsetLeft: 0,
          offsetTop: 0,
          width: 400,
          height: 0,
          scale: 1,
        },
        4,
      ).bottom,
    ).toBe(65_535);
  });
});

describe('PolkaVM host safe-area insets', () => {
  it.each([1, 2])('reserves the floating desktop band in physical pixels at DPR %s', ratio => {
    expect(safeAreaInsetsForFrame(fullFrame, desktopContent, ratio)).toEqual({
      ...zeroInsets,
      top: 68 * ratio,
    });
  });

  it('does not count the band twice when the frame is already below it', () => {
    expect(safeAreaInsetsForFrame(desktopContent, desktopContent, 2)).toEqual(zeroInsets);
  });

  it('does not count the phone bottom bar or OS safe edges twice', () => {
    const phoneContent = { left: 12, top: 24, right: 388, bottom: 732, width: 376, height: 708 };
    expect(safeAreaInsetsForFrame(phoneContent, phoneContent, 3)).toEqual(zeroInsets);
    expect(safeAreaInsetsForFrame(fullFrame, phoneContent, 2)).toEqual({
      left: 24,
      top: 48,
      right: 24,
      bottom: 136,
    });
  });

  it('reports no residual when chrome is absent', () => {
    expect(safeAreaInsetsForFrame(fullFrame, fullFrame, 2)).toEqual(zeroInsets);
  });

  it('bounds residuals to the frame and the input-record limit', () => {
    expect(safeAreaInsetsForFrame(fullFrame, { ...desktopContent, top: 900 }, 2).top).toBe(1600);
    expect(safeAreaInsetsForFrame(fullFrame, desktopContent, 1000).top).toBe(65_535);
    expect(safeAreaInsetsForFrame(fullFrame, desktopContent, Number.NaN).top).toBe(68);
    expect(safeAreaInsetsForFrame(fullFrame, { ...desktopContent, top: 68.25 }, 2).top).toBe(137);
  });
});

describe('PolkaVM visual viewport relay', () => {
  it('sends measured occlusion only to the matching product origin', () => {
    const visualViewport = Object.assign(new EventTarget(), {
      offsetLeft: 0,
      offsetTop: 0,
      width: 400,
      height: 600,
      scale: 1,
    }) as unknown as VisualViewport;
    vi.stubGlobal('visualViewport', visualViewport);
    vi.stubGlobal('devicePixelRatio', 2);
    vi.stubGlobal('ResizeObserver', undefined);
    vi.stubGlobal('matchMedia', () => new EventTarget());

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(fullFrame as DOMRect);
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 400,
      bottom: 800,
      width: 400,
      height: 800,
    } as DOMRect);
    const target = iframe.contentWindow;
    if (target === null) {
      throw new Error('test iframe has no content window');
    }
    const postMessage = vi.spyOn(target, 'postMessage').mockImplementation(() => {});
    const dispose = installPolkaVmViewInsetsRelay(iframe, 'https://product.test');

    iframe.dispatchEvent(new Event('load'));
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: POLKAVM_VIEW_INSETS,
        safeArea: zeroInsets,
        keyboard: { left: 0, top: 0, right: 0, bottom: 400 },
      },
      'https://product.test',
    );

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: POLKAVM_VIEW_INSETS_REQUEST },
        origin: 'https://attacker.test',
        source: target,
      }),
    );
    expect(postMessage).toHaveBeenCalledTimes(1);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: POLKAVM_VIEW_INSETS_REQUEST },
        origin: 'https://product.test',
        source: window,
      }),
    );
    expect(postMessage).toHaveBeenCalledTimes(1);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: POLKAVM_VIEW_INSETS_REQUEST },
        origin: 'https://product.test',
        source: target,
      }),
    );
    expect(postMessage).toHaveBeenCalledTimes(2);

    dispose();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: POLKAVM_VIEW_INSETS_REQUEST },
        origin: 'https://product.test',
        source: target,
      }),
    );
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it('publishes changed geometry and DPR, keeps the folded band stable, and tears down observers', () => {
    const state = { ...topbarStore.get(), present: false };
    vi.spyOn(topbarStore, 'get').mockReturnValue(state);
    const listeners = new Set<() => void>();
    vi.spyOn(topbarStore, 'subscribe').mockImplementation(listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    });
    const notifyTopbar = (): void => {
      for (const listener of listeners) {
        listener();
      }
    };
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id);
    });
    const flush = (): void => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) {
        callback(0);
      }
    };
    const resolutions: EventTarget[] = [];
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => {
        const query = new EventTarget();
        resolutions.push(query);
        return query;
      }),
    );
    let geometryChanged: (() => void) | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          geometryChanged = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    const viewport = Object.assign(new EventTarget(), {
      offsetLeft: 0,
      offsetTop: 0,
      width: 400,
      height: 800,
      scale: 1,
    });
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('devicePixelRatio', 1);
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    let actualFrame = fullFrame;
    // jsdom has no CSS layout: resolve the probe's selected box to realistic geometry.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === iframe) {
        return actualFrame as DOMRect;
      }
      return (this.style.top === productIframeBox({ topbarOffset: true }).top ? desktopContent : fullFrame) as DOMRect;
    });
    const target = iframe.contentWindow;
    if (target === null) {
      throw new Error('test iframe has no content window');
    }
    const postMessage = vi.spyOn(target, 'postMessage').mockImplementation(() => {});
    const dispose = installPolkaVmViewInsetsRelay(iframe, 'https://product.test');
    const probe = document.body.lastElementChild as HTMLElement;
    expect(probe).not.toBe(iframe);
    expect(probe.getAttribute('aria-hidden')).toBe('true');
    expect(probe.style.visibility).toBe('hidden');
    expect(probe.style.pointerEvents).toBe('none');
    expect(probe.inert).toBe(true);
    expect(observe).toHaveBeenCalledWith(probe);
    expect(observe).toHaveBeenCalledWith(iframe);
    iframe.dispatchEvent(new Event('load'));
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: POLKAVM_VIEW_INSETS,
        safeArea: zeroInsets,
        keyboard: zeroInsets,
      },
      'https://product.test',
    );

    state.present = true;
    notifyTopbar();
    flush();
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: POLKAVM_VIEW_INSETS,
        safeArea: { ...zeroInsets, top: 68 },
        keyboard: zeroInsets,
      },
      'https://product.test',
    );
    state.visible = false;
    notifyTopbar();
    state.visible = true;
    notifyTopbar();
    window.dispatchEvent(new Event('resize'));
    flush();
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(0);

    vi.stubGlobal('devicePixelRatio', 2);
    resolutions[0]?.dispatchEvent(new Event('change'));
    flush();
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: POLKAVM_VIEW_INSETS,
        safeArea: { ...zeroInsets, top: 136 },
        keyboard: zeroInsets,
      },
      'https://product.test',
    );
    expect(resolutions).toHaveLength(2);

    // The guest still needs to recompute CSS pixels when rounding leaves the wire values unchanged.
    vi.stubGlobal('devicePixelRatio', 2.001);
    resolutions[1]?.dispatchEvent(new Event('change'));
    flush();
    expect(postMessage).toHaveBeenCalledTimes(4);
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: POLKAVM_VIEW_INSETS,
        safeArea: { ...zeroInsets, top: 136 },
        keyboard: zeroInsets,
      },
      'https://product.test',
    );

    actualFrame = desktopContent;
    geometryChanged?.();
    flush();
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: POLKAVM_VIEW_INSETS,
        safeArea: zeroInsets,
        keyboard: zeroInsets,
      },
      'https://product.test',
    );
    actualFrame = fullFrame;
    state.present = false;
    notifyTopbar();
    flush();
    expect(postMessage).toHaveBeenCalledTimes(5);
    viewport.height = 600;
    viewport.dispatchEvent(new Event('resize'));
    flush();
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: POLKAVM_VIEW_INSETS,
        safeArea: zeroInsets,
        keyboard: { ...zeroInsets, bottom: 400 },
      },
      'https://product.test',
    );
    viewport.scale = 2;
    viewport.dispatchEvent(new Event('scroll'));
    flush();
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: POLKAVM_VIEW_INSETS,
        safeArea: zeroInsets,
        keyboard: zeroInsets,
      },
      'https://product.test',
    );
    iframe.dispatchEvent(new Event('load'));
    expect(postMessage).toHaveBeenCalledTimes(8);

    window.dispatchEvent(new Event('resize'));
    expect(frames.size).toBe(1);
    dispose();
    expect(probe.isConnected).toBe(false);
    expect(listeners.size).toBe(0);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    window.dispatchEvent(new Event('resize'));
    viewport.dispatchEvent(new Event('resize'));
    viewport.dispatchEvent(new Event('scroll'));
    resolutions[2]?.dispatchEvent(new Event('change'));
    iframe.dispatchEvent(new Event('load'));
    notifyTopbar();
    flush();
    expect(postMessage).toHaveBeenCalledTimes(8);
    expect(resolutions).toHaveLength(3);
  });
});
