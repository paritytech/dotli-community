// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { topbarState } from './state/topbarState.js';
import type { FrameBox } from './getFrameBox.js';
import { createProductFrameLayout, type ProductFrameLayout } from './createProductFrameLayout.js';
import { createStandInFrame } from './testing/createStandInFrame.js';

type RecordingLayout = {
  layout: ProductFrameLayout;
  /** Every box written onto `frame`, oldest first. */
  getBoxes: (frame: HTMLIFrameElement) => FrameBox[];
};

beforeEach(() => {
  topbarState.setPresent();
});

afterEach(() => {
  resetAllStoresForTests();
});

describe('product frame layout', () => {
  it('As a dApp user, I open a product and its new frame sits below the bar, clear of every inset', () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    const { frame } = createStandInFrame();

    // When
    layout.attach(frame);

    // Then
    expect(getBoxes(frame)).toEqual([{ belowBar: true, right: 0, bottom: 0 }]);
  });

  it('As a dApp user, I arm the bar and pin it again and the frame takes the full height and then sits below it', () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    const { frame } = createStandInFrame();
    layout.attach(frame);

    // When
    layout.setTopbarLayout({ offset: false });
    layout.setTopbarLayout({ offset: true });

    // Then
    expect(getBoxes(frame)).toEqual([
      { belowBar: true, right: 0, bottom: 0 },
      { belowBar: false, right: 0, bottom: 0 },
      { belowBar: true, right: 0, bottom: 0 },
    ]);
  });

  it('As a chat user, I open, resize and close chat and the frame narrows and is restored', () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    const { frame } = createStandInFrame();
    layout.attach(frame);

    // When
    layout.setChatWidth(360);
    layout.setChatWidth(420);
    layout.setChatWidth(0);

    // Then
    expect(getBoxes(frame).map(box => box.right)).toEqual([0, 360, 420, 0]);
  });

  it('As a chat user, I reload a product and the new frame keeps the chat-narrowed width', () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    layout.attach(createStandInFrame().frame);
    layout.setChatWidth(360);
    layout.setTopbarLayout({ offset: false });
    const { frame: reloaded } = createStandInFrame();

    // When the product re-renders into a new frame
    layout.attach(reloaded);

    // Then the new frame gets the whole layout
    expect(getBoxes(reloaded)).toEqual([{ belowBar: false, right: 360, bottom: 0 }]);
  });

  it('As a chat user, I close chat after a product reload and only the new frame resizes', () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    const { frame: first } = createStandInFrame();
    const { frame: second } = createStandInFrame();
    layout.attach(first);
    layout.setChatWidth(360);
    layout.attach(second);

    // When
    layout.setChatWidth(0);

    // Then
    expect({ first: getBoxes(first).at(-1)?.right, second: getBoxes(second).at(-1)?.right }).toEqual({
      first: 360,
      second: 0,
    });
  });

  it('As a dotli integrator, I set the layout before any product frame and it applies once one attaches', () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    layout.setChatWidth(360);
    layout.setTopbarLayout({ offset: false });
    const { frame } = createStandInFrame();

    // When
    layout.attach(frame);

    // Then
    expect(getBoxes(frame)).toEqual([{ belowBar: false, right: 360, bottom: 0 }]);
  });

  it('As a dotli integrator, I attach a frame on a page without a bar and it gets the full safe height', () => {
    // Given the sandbox app's page, which has no topbar
    resetAllStoresForTests();
    const { layout, getBoxes } = createRecordingLayout();
    const { frame } = createStandInFrame();

    // When
    layout.attach(frame);

    // Then
    expect(getBoxes(frame)).toEqual([{ belowBar: false, right: 0, bottom: 0 }]);
  });
});

describe('product frame layout: docked panels', () => {
  it('As a dotli developer, I dock a panel right and then at the bottom and the frame narrows and then shortens', () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    const { frame } = createStandInFrame();
    layout.attach(frame);

    // When
    layout.setDockInset({ right: 400, bottom: 0 }, 'debug');
    layout.setDockInset({ right: 0, bottom: 300 }, 'debug');

    // Then
    expect(getBoxes(frame)).toEqual([
      { belowBar: true, right: 0, bottom: 0 },
      { belowBar: true, right: 400, bottom: 0 },
      { belowBar: true, right: 0, bottom: 300 },
    ]);
  });

  it("As a dotli developer, I open, drag and close chat and the bottom dock's reservation stays", () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    const { frame } = createStandInFrame();
    layout.attach(frame);
    layout.setDockInset({ right: 0, bottom: 300 }, 'debug');

    // When chat opens, is dragged wider and closes
    layout.setChatWidth(360);
    layout.setChatWidth(420);
    layout.setChatWidth(0);

    // Then
    expect(getBoxes(frame).slice(-3)).toEqual([
      { belowBar: true, right: 360, bottom: 300 },
      { belowBar: true, right: 420, bottom: 300 },
      { belowBar: true, right: 0, bottom: 300 },
    ]);
  });

  it('As a dotli developer, I reload a product with chat open and a right dock and the new frame keeps both', () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    layout.attach(createStandInFrame().frame);
    layout.setChatWidth(360);
    layout.setDockInset({ right: 400, bottom: 0 }, 'debug');
    const { frame: reloaded } = createStandInFrame();

    // When the product re-renders into a new frame
    layout.attach(reloaded);

    // Then
    expect(getBoxes(reloaded)).toEqual([{ belowBar: true, right: 760, bottom: 0 }]);
  });

  it("As a dotli developer, I hide and reveal the bar and the bottom dock's reservation stays", () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    const { frame } = createStandInFrame();
    layout.attach(frame);
    layout.setDockInset({ right: 0, bottom: 300 }, 'debug');

    // When the bar hides and comes back
    layout.setTopbarLayout({ offset: false });
    layout.setTopbarLayout({ offset: true });

    // Then
    expect(getBoxes(frame).slice(-2)).toEqual([
      { belowBar: false, right: 0, bottom: 300 },
      { belowBar: true, right: 0, bottom: 300 },
    ]);
  });

  it('As a dotli developer, I close the dock with chat open and the full layout is restored', () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    const { frame } = createStandInFrame();
    layout.attach(frame);
    layout.setChatWidth(360);
    layout.setTopbarLayout({ offset: false });
    layout.setDockInset({ right: 0, bottom: 300 }, 'debug');

    // When
    layout.setDockInset({ right: 0, bottom: 0 }, 'debug');

    // Then chat and the tracked bar still apply
    expect(getBoxes(frame).at(-1)).toEqual({ belowBar: false, right: 360, bottom: 0 });
  });

  it('As a dotli developer, I dock the debug panel and the sandbox checker together and they reserve their space side by side', () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    const { frame } = createStandInFrame();
    layout.attach(frame);

    // When both panels sit at the bottom, then the sandbox checker goes away
    layout.setDockInset({ right: 0, bottom: 300 }, 'debug');
    layout.setDockInset({ right: 0, bottom: 120 }, 'sandbox-checker');
    layout.setDockInset({ right: 0, bottom: 0 }, 'sandbox-checker');

    // Then the debug dock keeps its space
    expect(getBoxes(frame).map(box => box.bottom)).toEqual([0, 300, 420, 300]);
  });

  it('As a dotli integrator, I report a dock before any product frame and it applies once one attaches', () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    layout.setDockInset({ right: 0, bottom: 300 }, 'debug');
    const { frame } = createStandInFrame();

    // When
    layout.attach(frame);

    // Then
    expect(getBoxes(frame)).toEqual([{ belowBar: true, right: 0, bottom: 300 }]);
  });
});

describe('product frame layout: the frame on the page', () => {
  it('As a dApp user, I answer a dialog during a reload and focus goes back to the frame attached last', () => {
    // Given
    const { layout } = createRecordingLayout();
    const { frame: outgoing } = createStandInFrame();
    const { frame: incoming } = createStandInFrame();
    layout.attach(outgoing);

    // When
    layout.attach(incoming);

    // Then
    expect(layout.getFocusFallback()).toBe(incoming);
  });

  it('As a dApp user, I see a frame leave the page and it is no longer the product frame', () => {
    // Given
    const { layout } = createRecordingLayout();
    const incoming = createStandInFrame();
    layout.attach(incoming.frame);

    // When
    incoming.remove();

    // Then
    expect({ frame: layout.getFrame(), focus: layout.getFocusFallback() }).toEqual({
      frame: null,
      focus: undefined,
    });
  });
});

/** Builds a layout that records the boxes it writes onto each frame. */
function createRecordingLayout(): RecordingLayout {
  const boxes = new Map<HTMLIFrameElement, FrameBox[]>();
  const layout = createProductFrameLayout({
    apply(frame, box) {
      boxes.set(frame, [...(boxes.get(frame) ?? []), box]);
    },
  });
  return { layout, getBoxes: frame => boxes.get(frame) ?? [] };
}
