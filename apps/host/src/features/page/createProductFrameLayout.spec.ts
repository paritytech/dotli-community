// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { createProductFrameLayout, type FrameBox, type ProductFrameLayout } from './createProductFrameLayout.js';
import { createStandInFrame } from '../../testing/createStandInFrame.js';

type Params = {
  /** Whether the page has the host's topbar, as the host's page does unless told otherwise. */
  present?: boolean;
  /** Whether the viewport starts phone sized, as it does not unless told otherwise. */
  phone?: boolean;
};

type RecordingLayout = {
  layout: ProductFrameLayout;
  /** Every box written onto `frame`, oldest first. */
  getBoxes: (frame: HTMLIFrameElement) => FrameBox[];
  /** Every stage marked on the page, oldest first. */
  getStages: () => boolean[];
  /** Moves the viewport across the phone breakpoint. */
  setPhone: (phone: boolean) => void;
};

describe('product frame layout', () => {
  it('As a dApp user, I open a product and its new frame sits below the bar, clear of every inset', () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    const { frame } = createStandInFrame();

    // When
    layout.attach(frame);

    // Then
    expect(getBoxes(frame)).toEqual([{ placement: 'belowBar', morph: false, right: 0, bottom: 0 }]);
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
      { placement: 'belowBar', morph: false, right: 0, bottom: 0 },
      { placement: 'full', morph: false, right: 0, bottom: 0 },
      { placement: 'belowBar', morph: false, right: 0, bottom: 0 },
    ]);
  });

  it('As a dotli developer, I reload a product and the new frame keeps clear of the docked panel', () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    layout.attach(createStandInFrame().frame);
    layout.setDockInset({ right: 360, bottom: 0 }, 'debug');
    layout.setTopbarLayout({ offset: false });
    const { frame: reloaded } = createStandInFrame();

    // When the product re-renders into a new frame
    layout.attach(reloaded);

    // Then the new frame gets the whole layout
    expect(getBoxes(reloaded)).toEqual([{ placement: 'full', morph: false, right: 360, bottom: 0 }]);
  });

  it('As a dotli developer, I close a docked panel after a product reload and only the new frame resizes', () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    const { frame: first } = createStandInFrame();
    const { frame: second } = createStandInFrame();
    layout.attach(first);
    layout.setDockInset({ right: 360, bottom: 0 }, 'debug');
    layout.attach(second);

    // When
    layout.setDockInset({ right: 0, bottom: 0 }, 'debug');

    // Then
    expect({ first: getBoxes(first).at(-1)?.right, second: getBoxes(second).at(-1)?.right }).toEqual({
      first: 360,
      second: 0,
    });
  });

  it('As a dotli integrator, I set the layout before any product frame and it applies once one attaches', () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    layout.setDockInset({ right: 360, bottom: 0 }, 'debug');
    layout.setTopbarLayout({ offset: false });
    const { frame } = createStandInFrame();

    // When
    layout.attach(frame);

    // Then
    expect(getBoxes(frame)).toEqual([{ placement: 'full', morph: false, right: 360, bottom: 0 }]);
  });

  it('As a dotli integrator, I attach a frame on a page without a bar and it gets the full safe height', () => {
    // Given the sandbox app's page, which has no topbar
    const { layout, getBoxes } = createRecordingLayout({ present: false });
    const { frame } = createStandInFrame();

    // When
    layout.attach(frame);

    // Then
    expect(getBoxes(frame)).toEqual([{ placement: 'full', morph: false, right: 0, bottom: 0 }]);
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
      { placement: 'belowBar', morph: false, right: 0, bottom: 0 },
      { placement: 'belowBar', morph: false, right: 400, bottom: 0 },
      { placement: 'belowBar', morph: false, right: 0, bottom: 300 },
    ]);
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

describe('product frame layout: the stage', () => {
  it('As a dApp user, I open a side panel on a wide screen and the page stages with the frame as a card beside it', () => {
    // Given
    const { layout, getBoxes, getStages } = createRecordingLayout();
    const { frame } = createStandInFrame();
    layout.attach(frame);

    // When
    layout.setSidePanel({ docked: true });

    // Then
    expect({ box: getBoxes(frame).at(-1), stages: getStages() }).toEqual({
      box: { placement: 'staged', morph: true, right: 0, bottom: 0 },
      stages: [true],
    });
  });

  it('As a dApp user, I report the side panel docked twice and the page stages once', () => {
    // Given
    const { layout, getBoxes, getStages } = createRecordingLayout();
    const { frame } = createStandInFrame();
    layout.attach(frame);

    // When
    layout.setSidePanel({ docked: true });
    layout.setSidePanel({ docked: true });

    // Then
    expect({ boxes: getBoxes(frame).length, stages: getStages() }).toEqual({ boxes: 2, stages: [true] });
  });

  it('As a dApp user on a phone, I open a side panel and the page is not staged', () => {
    // Given
    const { layout, getBoxes, getStages } = createRecordingLayout({ phone: true });
    const { frame } = createStandInFrame();
    layout.attach(frame);

    // When
    layout.setSidePanel({ docked: true });

    // Then
    expect({ boxes: getBoxes(frame).length, stages: getStages() }).toEqual({ boxes: 1, stages: [] });
  });

  it('As a dApp user, I narrow the window to a phone with the side panel open and the frame morphs out of the stage', () => {
    // Given
    const { layout, getBoxes, getStages, setPhone } = createRecordingLayout();
    const { frame } = createStandInFrame({ transitions: true });
    layout.attach(frame);
    layout.setSidePanel({ docked: true });

    // When
    setPhone(true);

    // Then
    expect({ box: getBoxes(frame).at(-1), stages: getStages() }).toEqual({
      box: { placement: 'belowBar', morph: true, right: 0, bottom: 0 },
      stages: [true, false],
    });
  });

  it('As a dApp user, I close the side panel and widening the window no longer stages the page', () => {
    // Given
    const { layout, getStages, setPhone } = createRecordingLayout({ phone: true });
    layout.setSidePanel({ docked: true });
    layout.setSidePanel({ docked: false });

    // When
    setPhone(false);

    // Then
    expect(getStages()).toEqual([]);
  });

  it('As a dApp user, I close the side panel and the frame morphs back and then changes at once', () => {
    // Given
    const { layout, getBoxes, getStages } = createRecordingLayout();
    const stand = createStandInFrame({ transitions: true });
    layout.attach(stand.frame);
    layout.setSidePanel({ docked: true });

    // When
    layout.setSidePanel({ docked: false });
    stand.endTransition();

    // Then
    expect({
      boxes: getBoxes(stand.frame).map(({ placement, morph }) => ({ placement, morph })),
      stages: getStages(),
    }).toEqual({
      boxes: [
        { placement: 'belowBar', morph: false },
        { placement: 'staged', morph: true },
        { placement: 'belowBar', morph: true },
        { placement: 'belowBar', morph: false },
      ],
      stages: [true, false],
    });
  });

  it('As a dApp user who prefers reduced motion, I close the side panel and the next change of the frame lands at once', () => {
    // Given a frame that runs no transition
    const { layout, getBoxes } = createRecordingLayout();
    const { frame } = createStandInFrame();
    layout.attach(frame);
    layout.setSidePanel({ docked: true });
    layout.setSidePanel({ docked: false });

    // When
    layout.setDockInset({ right: 360, bottom: 0 }, 'debug');

    // Then
    expect(getBoxes(frame).at(-1)?.morph).toBe(false);
  });

  it('As a dApp user, I change the frame mid-morph back, which replaces its transition, and its next change still morphs', () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    const stand = createStandInFrame({ transitions: true });
    layout.attach(stand.frame);
    layout.setSidePanel({ docked: true });
    layout.setSidePanel({ docked: false });

    // When the change replaces the running transition
    stand.replaceTransition();
    layout.setDockInset({ right: 360, bottom: 0 }, 'debug');

    // Then
    expect(getBoxes(stand.frame).at(-1)?.morph).toBe(true);
  });

  it('As a dotli developer, I reset the stores while the page is staged and the page is no longer marked staged', () => {
    // Given
    const { layout, getStages } = createRecordingLayout();
    layout.attach(createStandInFrame().frame);
    layout.setSidePanel({ docked: true });

    // When
    resetAllStoresForTests();

    // Then
    expect(getStages()).toEqual([true, false]);
  });

  it('As a dApp user, I open another product while the frame morphs back and the new frame changes at once', () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    layout.attach(createStandInFrame({ transitions: true }).frame);
    layout.setSidePanel({ docked: true });
    layout.setSidePanel({ docked: false });
    const { frame: next } = createStandInFrame();

    // When
    layout.attach(next);

    // Then
    expect(getBoxes(next).at(-1)?.morph).toBe(false);
  });

  it('As a dApp user, I open and close the side panel before any product frame and the first frame changes at once', () => {
    // Given
    const { layout, getBoxes } = createRecordingLayout();
    layout.setSidePanel({ docked: true });
    layout.setSidePanel({ docked: false });
    const { frame } = createStandInFrame();

    // When
    layout.attach(frame);

    // Then
    expect(getBoxes(frame)).toEqual([{ placement: 'belowBar', morph: false, right: 0, bottom: 0 }]);
  });
});

/** Builds a layout that records the boxes it writes onto each frame and the stages it marks on the page. */
function createRecordingLayout({ present = true, phone = false }: Params = {}): RecordingLayout {
  const boxes = new Map<HTMLIFrameElement, FrameBox[]>();
  const stages: boolean[] = [];
  const phoneWatchers = new Set<() => void>();
  let isPhone = phone;
  const layout = createProductFrameLayout({
    apply(frame, box) {
      boxes.set(frame, [...(boxes.get(frame) ?? []), box]);
    },
    applyStage(staged) {
      stages.push(staged);
    },
    topbar: { get: () => ({ present }) },
    isPhone: () => isPhone,
    watchPhone(onChange) {
      phoneWatchers.add(onChange);
      return () => {
        phoneWatchers.delete(onChange);
      };
    },
  });
  return {
    layout,
    getBoxes: frame => boxes.get(frame) ?? [],
    getStages: () => stages,
    setPhone(next) {
      isPhone = next;
      for (const onChange of phoneWatchers) {
        onChange();
      }
    },
  };
}
