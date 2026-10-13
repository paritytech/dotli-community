// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { setTopbarPresent } from './state/topbar.js';
import {
  attachProductFrame,
  currentProductFrame,
  frameBox,
  resetProductFrameLayout,
  setChatWidth,
  setDockInset,
  setTopbarLayout,
  type FrameBox,
} from './product-frame-layout.js';

/** A stand-in frame recording every box written to it. */
function recordingFrame(): { frame: HTMLIFrameElement; boxes: FrameBox[]; last: () => FrameBox | undefined } {
  const boxes: FrameBox[] = [];
  const frame = { isConnected: true } as HTMLIFrameElement;
  return {
    frame,
    boxes,
    last: () => boxes.at(-1),
  };
}

function attach(recording: ReturnType<typeof recordingFrame>): void {
  attachProductFrame(recording.frame, (_frame, box) => {
    recording.boxes.push(box);
  });
}

beforeEach(() => {
  setTopbarPresent();
});

afterEach(() => {
  resetAllStoresForTests();
  resetProductFrameLayout();
});

describe('frameBox', () => {
  it('As a dApp user, a frame with no chat and no dock reserves nothing at its edges', () => {
    // When
    const box = frameBox({ topbarOffset: true, chatWidth: 0, docks: {} });

    // Then
    expect(box).toEqual({ belowBar: true, right: 0, bottom: 0 });
  });

  it('As a dotli developer, chat and every dock add up at the edge they share', () => {
    // When
    const box = frameBox({
      topbarOffset: false,
      chatWidth: 360,
      docks: { debug: { right: 400, bottom: 300 }, 'sandbox-checker': { right: 0, bottom: 120 } },
    });

    // Then
    expect(box).toEqual({ belowBar: false, right: 760, bottom: 420 });
  });
});

describe('product frame layout', () => {
  it('As a dApp user, a new product frame sits below the bar, clear of every inset', () => {
    // Given
    const frame = recordingFrame();

    // When
    attach(frame);

    // Then
    expect(frame.boxes).toEqual([{ belowBar: true, right: 0, bottom: 0 }]);
  });

  it('As a dApp user with the bar armed, the frame takes the full height and the pill floats over it', () => {
    // Given
    const frame = recordingFrame();
    attach(frame);

    // When
    setTopbarLayout({ offset: false });

    // Then
    expect(frame.last()).toEqual({ belowBar: false, right: 0, bottom: 0 });

    // When the bar is pinned again
    setTopbarLayout({ offset: true });

    // Then
    expect(frame.last()).toEqual({ belowBar: true, right: 0, bottom: 0 });
  });

  it('As a chat user, opening, resizing and closing chat narrows and restores the frame', () => {
    // Given
    const frame = recordingFrame();
    attach(frame);

    // When
    setChatWidth(360);

    // Then
    expect(frame.last()?.right).toBe(360);

    // When
    setChatWidth(420);

    // Then
    expect(frame.last()?.right).toBe(420);

    // When
    setChatWidth(0);

    // Then
    expect(frame.last()?.right).toBe(0);
  });

  it('As a chat user, a product reload keeps the chat-narrowed width', () => {
    // Given
    const first = recordingFrame();
    attach(first);
    setChatWidth(360);
    setTopbarLayout({ offset: false });

    // When the product re-renders into a new frame
    const second = recordingFrame();
    attach(second);

    // Then the new frame gets the whole layout
    expect(second.boxes).toEqual([{ belowBar: false, right: 360, bottom: 0 }]);

    // Later writes go to the latest frame only.
    setChatWidth(0);
    expect(second.last()?.right).toBe(0);
    expect(first.last()?.right).toBe(360);
  });

  it('As a dotli integrator, layout set before any product frame applies once one attaches', () => {
    // Given
    setChatWidth(360);
    setTopbarLayout({ offset: false });
    const frame = recordingFrame();

    // When
    attach(frame);

    // Then
    expect(frame.boxes).toEqual([{ belowBar: false, right: 360, bottom: 0 }]);
  });

  it('As a dotli integrator, a page without a bar gives the frame the full safe height', () => {
    // Given: the sandbox app's page, which has no topbar.
    resetAllStoresForTests();
    const frame = recordingFrame();

    // When
    attach(frame);

    // Then
    expect(frame.last()?.belowBar).toBe(false);
  });
});

describe('product frame layout: docked panels', () => {
  it('As a dotli developer, a right dock narrows the frame and a bottom dock shortens it', () => {
    // Given
    const frame = recordingFrame();
    attach(frame);

    // When
    setDockInset({ right: 400, bottom: 0 }, 'debug');

    // Then
    expect(frame.last()).toEqual({ belowBar: true, right: 400, bottom: 0 });

    // When
    setDockInset({ right: 0, bottom: 300 }, 'debug');

    // Then
    expect(frame.last()).toEqual({ belowBar: true, right: 0, bottom: 300 });
  });

  it("As a dotli developer, opening, dragging and closing chat keeps the bottom dock's reservation", () => {
    // Given
    const frame = recordingFrame();
    attach(frame);
    setDockInset({ right: 0, bottom: 300 }, 'debug');

    // When chat opens
    setChatWidth(360);

    // Then
    expect(frame.last()).toEqual({ belowBar: true, right: 360, bottom: 300 });

    // When chat is dragged wider
    setChatWidth(420);

    // Then
    expect(frame.last()).toEqual({ belowBar: true, right: 420, bottom: 300 });

    // When chat closes
    setChatWidth(0);

    // Then
    expect(frame.last()).toEqual({ belowBar: true, right: 0, bottom: 300 });
  });

  it('As a dotli developer, a product reload with chat open and a right dock keeps both', () => {
    // Given
    const first = recordingFrame();
    attach(first);
    setChatWidth(360);
    setDockInset({ right: 400, bottom: 0 }, 'debug');

    // When the product re-renders into a new frame
    const second = recordingFrame();
    attach(second);

    // Then
    expect(second.last()).toEqual({ belowBar: true, right: 760, bottom: 0 });
  });

  it("As a dotli developer, hiding and revealing the bar keeps the bottom dock's reservation", () => {
    // Given
    const frame = recordingFrame();
    attach(frame);
    setDockInset({ right: 0, bottom: 300 }, 'debug');

    // When the bar hides
    setTopbarLayout({ offset: false });

    // Then
    expect(frame.last()).toEqual({ belowBar: false, right: 0, bottom: 300 });

    // When the bar comes back
    setTopbarLayout({ offset: true });

    // Then
    expect(frame.last()).toEqual({ belowBar: true, right: 0, bottom: 300 });
  });

  it('As a dotli developer, closing the dock with chat open restores the full layout', () => {
    // Given
    const frame = recordingFrame();
    attach(frame);
    setChatWidth(360);
    setTopbarLayout({ offset: false });
    setDockInset({ right: 0, bottom: 300 }, 'debug');

    // When
    setDockInset({ right: 0, bottom: 0 }, 'debug');

    // Then chat and the tracked bar still apply
    expect(frame.last()).toEqual({ belowBar: false, right: 360, bottom: 0 });
  });

  it('As a dotli developer, the debug dock and the sandbox checker reserve their space side by side', () => {
    // Given
    const frame = recordingFrame();
    attach(frame);

    // When both panels sit at the bottom
    setDockInset({ right: 0, bottom: 300 }, 'debug');
    setDockInset({ right: 0, bottom: 120 }, 'sandbox-checker');

    // Then
    expect(frame.last()?.bottom).toBe(420);

    // When the sandbox checker goes away
    setDockInset({ right: 0, bottom: 0 }, 'sandbox-checker');

    // Then the debug dock keeps its space
    expect(frame.last()?.bottom).toBe(300);
  });

  it('As a dotli integrator, a dock reported before any product frame applies once one attaches', () => {
    // Given
    setDockInset({ right: 0, bottom: 300 }, 'debug');
    const frame = recordingFrame();

    // When
    attach(frame);

    // Then
    expect(frame.boxes).toEqual([{ belowBar: true, right: 0, bottom: 300 }]);
  });
});

describe('currentProductFrame', () => {
  it('As a dialog handing focus back, I get the frame attached last, and none once it left the page', () => {
    // Given
    const outgoing = { isConnected: true } as HTMLIFrameElement;
    const incoming = { isConnected: true };

    // When
    attachProductFrame(outgoing, () => undefined);
    attachProductFrame(incoming as HTMLIFrameElement, () => undefined);

    // Then
    expect(currentProductFrame()).toBe(incoming);

    // When
    incoming.isConnected = false;

    // Then
    expect(currentProductFrame()).toBeNull();
  });
});
