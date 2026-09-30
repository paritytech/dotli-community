// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetAllStoresForTests } from '../src/state/create-store.js';
import { setTopbarPresent } from '../src/state/topbar.js';
import {
  attachProductFrame,
  currentProductFrame,
  resetProductFrameLayout,
  setChatWidth,
  setDockInset,
  setTopbarLayout,
} from '../src/product-frame-layout.js';

/**
 * These assert the declared style, not the resolved pixels.
 *
 * happy-dom's CSS parser discards a `calc()` that holds a `var()`, so a real
 * iframe would read back empty strings for the inset-aware values. The frame
 * here is a stand-in whose style records each declaration as written.
 */
type RecordedStyle = Record<string, string>;

function recordingFrame(): {
  frame: HTMLIFrameElement;
  style: RecordedStyle;
} {
  const style: RecordedStyle = {};
  return { frame: { style } as unknown as HTMLIFrameElement, style };
}

const SAFE_WIDTH = 'calc(100% - var(--safe-left, 0px) - var(--safe-right, 0px))';
const BELOW_BAR_TOP = 'var(--topbar-height, 56px)';
const BELOW_BAR_HEIGHT = 'calc(100dvh - var(--topbar-height, 56px) - var(--safe-bottom, 0px))';
const HIDDEN_BAR_TOP = 'var(--safe-top, 0px)';
const HIDDEN_BAR_HEIGHT = 'calc(100dvh - var(--safe-top, 0px) - var(--safe-bottom, 0px))';
const SHIFT_BELOW_BAR = 'translateY(calc(var(--topbar-height, 56px) - var(--safe-top, 0px)))';
const SLIDE = 'transform 0.3s ease';

beforeEach(() => {
  // The host page, which has the topbar.
  setTopbarPresent();
});

afterEach(() => {
  resetAllStoresForTests();
  resetProductFrameLayout();
});

describe('product frame layout', () => {
  it('As a dApp user, a new product frame sits below the bar, clear of every inset', () => {
    // Given
    const { frame, style } = recordingFrame();

    // When
    attachProductFrame(frame);

    // Then
    expect(style).toEqual({
      position: 'fixed',
      top: BELOW_BAR_TOP,
      left: 'var(--safe-left, 0px)',
      width: SAFE_WIDTH,
      height: BELOW_BAR_HEIGHT,
      transform: '',
      transition: '',
      border: 'none',
      margin: '0',
      padding: '0',
    });
  });

  it('As a dApp user, hiding and revealing the bar moves the frame by transform only', () => {
    // Given
    const { frame, style } = recordingFrame();
    attachProductFrame(frame);

    // When the bar hides
    setTopbarLayout({ offset: false, shown: false, transition: SLIDE });

    // Then
    expect(style['top']).toBe(HIDDEN_BAR_TOP);
    expect(style['height']).toBe(HIDDEN_BAR_HEIGHT);
    expect(style['transform']).toBe('translateY(0)');
    expect(style['transition']).toBe(SLIDE);

    // When the bar comes back
    setTopbarLayout({ offset: false, shown: true, transition: SLIDE });

    // Then the layout box stays, and the transform shifts the frame down
    expect(style['top']).toBe(HIDDEN_BAR_TOP);
    expect(style['height']).toBe(HIDDEN_BAR_HEIGHT);
    expect(style['transform']).toBe(SHIFT_BELOW_BAR);

    // When the bar is pinned again
    setTopbarLayout({ offset: true, shown: true, transition: '' });

    // Then
    expect(style['top']).toBe(BELOW_BAR_TOP);
    expect(style['height']).toBe(BELOW_BAR_HEIGHT);
    expect(style['transform']).toBe('');
    expect(style['transition']).toBe('');
  });

  it('As a reduced-motion user, the frame follows the bar without a slide', () => {
    // Given
    const { frame, style } = recordingFrame();
    attachProductFrame(frame);

    // When
    setTopbarLayout({ offset: false, shown: false, transition: 'none' });

    // Then
    expect(style['transition']).toBe('none');
  });

  it('As a chat user, opening, resizing and closing chat narrows and restores the frame', () => {
    // Given
    const { frame, style } = recordingFrame();
    attachProductFrame(frame);

    // When
    setChatWidth(360);

    // Then
    expect(style['width']).toBe(`calc(${SAFE_WIDTH} - 360px)`);

    // When
    setChatWidth(420);

    // Then
    expect(style['width']).toBe(`calc(${SAFE_WIDTH} - 420px)`);

    // When
    setChatWidth(0);

    // Then
    expect(style['width']).toBe(SAFE_WIDTH);
  });

  it('As a chat user on a notched phone, the chat-narrowed frame still keeps clear of the side insets', () => {
    // Given
    const { frame, style } = recordingFrame();
    attachProductFrame(frame);

    // When
    setChatWidth(360);

    // Then
    expect(style['width']).toContain('var(--safe-left, 0px)');
    expect(style['width']).toContain('var(--safe-right, 0px)');
    expect(style['left']).toBe('var(--safe-left, 0px)');
  });

  it('As a chat user, a product reload keeps the chat-narrowed width', () => {
    // Given
    const first = recordingFrame();
    attachProductFrame(first.frame);
    setChatWidth(360);
    setTopbarLayout({ offset: false, shown: false, transition: SLIDE });

    // When the product re-renders into a new frame
    const second = recordingFrame();
    attachProductFrame(second.frame);

    // Then the new frame gets the whole layout
    expect(second.style['width']).toBe(`calc(${SAFE_WIDTH} - 360px)`);
    expect(second.style['top']).toBe(HIDDEN_BAR_TOP);
    expect(second.style['transform']).toBe('translateY(0)');

    // And later writes go to the latest frame only
    setChatWidth(0);
    expect(second.style['width']).toBe(SAFE_WIDTH);
    expect(first.style['width']).toBe(`calc(${SAFE_WIDTH} - 360px)`);
  });

  it('As a dotli integrator, layout set before any product frame applies once one attaches', () => {
    // Given
    setChatWidth(360);
    setTopbarLayout({ offset: false, shown: true, transition: SLIDE });
    const { frame, style } = recordingFrame();

    // When
    attachProductFrame(frame);

    // Then
    expect(style['width']).toBe(`calc(${SAFE_WIDTH} - 360px)`);
    expect(style['top']).toBe(HIDDEN_BAR_TOP);
    expect(style['transform']).toBe(SHIFT_BELOW_BAR);
    expect(style['transition']).toBe(SLIDE);
  });

  it('As a dotli integrator, a page without a bar gives the frame the full safe height', () => {
    // Given: the sandbox app's page, which has no topbar.
    resetAllStoresForTests();
    const { frame, style } = recordingFrame();

    // When
    attachProductFrame(frame);

    // Then
    expect(style['top']).toBe(HIDDEN_BAR_TOP);
    expect(style['height']).toBe(HIDDEN_BAR_HEIGHT);
    expect(style['transform']).toBe('');
  });
});

describe('product frame layout: docked panels', () => {
  it('As a dotli developer, a right dock narrows the frame and a bottom dock shortens it', () => {
    // Given
    const { frame, style } = recordingFrame();
    attachProductFrame(frame);

    // When
    setDockInset({ right: 400, bottom: 0 }, 'debug');

    // Then
    expect(style['width']).toBe(`calc(${SAFE_WIDTH} - 400px)`);
    expect(style['height']).toBe(BELOW_BAR_HEIGHT);

    // When
    setDockInset({ right: 0, bottom: 300 }, 'debug');

    // Then
    expect(style['width']).toBe(SAFE_WIDTH);
    expect(style['height']).toBe(`calc(${BELOW_BAR_HEIGHT} - 300px)`);
  });

  it("As a dotli developer, opening, dragging and closing chat keeps the bottom dock's reservation", () => {
    // Given
    const { frame, style } = recordingFrame();
    attachProductFrame(frame);
    setDockInset({ right: 0, bottom: 300 }, 'debug');

    // When chat opens
    setChatWidth(360);

    // Then
    expect(style['width']).toBe(`calc(${SAFE_WIDTH} - 360px)`);
    expect(style['height']).toBe(`calc(${BELOW_BAR_HEIGHT} - 300px)`);

    // When chat is dragged wider
    setChatWidth(420);

    // Then
    expect(style['width']).toBe(`calc(${SAFE_WIDTH} - 420px)`);
    expect(style['height']).toBe(`calc(${BELOW_BAR_HEIGHT} - 300px)`);

    // When chat closes
    setChatWidth(0);

    // Then
    expect(style['width']).toBe(SAFE_WIDTH);
    expect(style['height']).toBe(`calc(${BELOW_BAR_HEIGHT} - 300px)`);
  });

  it('As a dotli developer, a product reload with chat open and a right dock keeps both', () => {
    // Given
    const first = recordingFrame();
    attachProductFrame(first.frame);
    setChatWidth(360);
    setDockInset({ right: 400, bottom: 0 }, 'debug');

    // When the product re-renders into a new frame
    const second = recordingFrame();
    attachProductFrame(second.frame);

    // Then
    expect(second.style['width']).toBe(`calc(${SAFE_WIDTH} - 760px)`);
    expect(second.style['height']).toBe(BELOW_BAR_HEIGHT);
  });

  it("As a dotli developer, hiding and revealing the bar keeps the bottom dock's reservation", () => {
    // Given
    const { frame, style } = recordingFrame();
    attachProductFrame(frame);
    setDockInset({ right: 0, bottom: 300 }, 'debug');

    // When the bar hides
    setTopbarLayout({ offset: false, shown: false, transition: SLIDE });

    // Then
    expect(style['height']).toBe(`calc(${HIDDEN_BAR_HEIGHT} - 300px)`);
    expect(style['transform']).toBe('translateY(0)');

    // When the bar comes back
    setTopbarLayout({ offset: false, shown: true, transition: SLIDE });

    // Then
    expect(style['height']).toBe(`calc(${HIDDEN_BAR_HEIGHT} - 300px)`);
    expect(style['transform']).toBe(SHIFT_BELOW_BAR);
  });

  it('As a dotli developer, closing the dock with chat open restores the full layout', () => {
    // Given
    const { frame, style } = recordingFrame();
    attachProductFrame(frame);
    setChatWidth(360);
    setTopbarLayout({ offset: false, shown: false, transition: SLIDE });
    setDockInset({ right: 0, bottom: 300 }, 'debug');

    // When
    setDockInset({ right: 0, bottom: 0 }, 'debug');

    // Then chat, the safe insets and the tracked bar all still apply
    expect(style).toEqual({
      position: 'fixed',
      top: HIDDEN_BAR_TOP,
      left: 'var(--safe-left, 0px)',
      width: `calc(${SAFE_WIDTH} - 360px)`,
      height: HIDDEN_BAR_HEIGHT,
      transform: 'translateY(0)',
      transition: SLIDE,
      border: 'none',
      margin: '0',
      padding: '0',
    });
  });

  it('As a dotli developer, the debug dock and the sandbox checker reserve their space side by side', () => {
    // Given
    const { frame, style } = recordingFrame();
    attachProductFrame(frame);

    // When both panels sit at the bottom
    setDockInset({ right: 0, bottom: 300 }, 'debug');
    setDockInset({ right: 0, bottom: 120 }, 'sandbox-checker');

    // Then
    expect(style['height']).toBe(`calc(${BELOW_BAR_HEIGHT} - 420px)`);

    // When the sandbox checker goes away
    setDockInset({ right: 0, bottom: 0 }, 'sandbox-checker');

    // Then the debug dock keeps its space
    expect(style['height']).toBe(`calc(${BELOW_BAR_HEIGHT} - 300px)`);
  });

  it('As a dotli integrator, a dock reported before any product frame applies once one attaches', () => {
    // Given
    setDockInset({ right: 0, bottom: 300 }, 'debug');
    const { frame, style } = recordingFrame();

    // When
    attachProductFrame(frame);

    // Then
    expect(style['height']).toBe(`calc(${BELOW_BAR_HEIGHT} - 300px)`);
  });
});

describe('currentProductFrame', () => {
  afterEach(() => {
    resetProductFrameLayout();
    document.body.replaceChildren();
  });

  it('As a dialog handing focus back, I get the frame attached last, and none once it left the page', () => {
    // Given
    const outgoing = document.createElement('iframe');
    const incoming = document.createElement('iframe');
    document.body.append(outgoing, incoming);

    // When
    attachProductFrame(outgoing);
    attachProductFrame(incoming);

    // Then
    expect(currentProductFrame()).toBe(incoming);

    // When
    incoming.remove();

    // Then
    expect(currentProductFrame()).toBeNull();
  });
});
