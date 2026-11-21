// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { getDragVerdict, isBlurringTap, isKeyboardOpen, pinPageAboveKeyboard } from './pinPageAboveKeyboard.js';

const LAYOUT_HEIGHT = 800;

/**
 * A landing page with one field inside its scroll box and one in an overlay, a header in the page box but outside its
 * scroll box, a list portaled out of the page box, a keyboard that opens and closes, and a log of what the helper does
 * to the page beyond the page box's own attributes.
 */
function createFakePage() {
  const log: string[] = [];
  const written = new Map<string, string>();
  const focus = { withinPage: false };
  const field = {
    closest: () => field,
    scrollIntoView: () => log.push('field scrolled into view'),
    blur: () => log.push('field blurred'),
  };
  const overlayField = {
    closest: () => overlayField,
    scrollIntoView: () => log.push('overlay field scrolled into view'),
    blur: () => log.push('overlay field blurred'),
  };
  const text = { closest: () => null };
  const header = { closest: () => null };
  const list = { closest: () => null };
  const page = {
    contains: (other: unknown) => other === field || other === text || other === header,
    matches: (selector: string) => selector === ':focus-within' && focus.withinPage,
    setAttribute: (name: string, value: string) => written.set(name, value),
    removeAttribute: (name: string) => written.delete(name),
    style: {
      setProperty: (name: string, value: string | null) => written.set(name, value ?? ''),
      removeProperty: (name: string) => {
        written.delete(name);
        return '';
      },
    },
  };
  const scroller = {
    scrollTop: 40,
    clientHeight: 500,
    scrollHeight: 1000,
    contains: (other: unknown) => other === field || other === text,
  };
  const visualViewport = Object.assign(new EventTarget(), { height: LAYOUT_HEIGHT, offsetTop: 0 });
  const window = { innerHeight: LAYOUT_HEIGHT, scrollTo: () => log.push('window scrolled to top') };
  const document: EventTarget & { activeElement: typeof field | null } = Object.assign(new EventTarget(), {
    activeElement: null,
  });

  return {
    log,
    written,
    scroller,
    text,
    header,
    list,
    start: () => pinPageAboveKeyboard({ page, scroller, visualViewport, window, document }),
    focusField(): void {
      focus.withinPage = true;
      document.activeElement = field;
      document.dispatchEvent(new Event('focusin'));
    },
    focusOverlayField(): void {
      focus.withinPage = false;
      document.activeElement = overlayField;
      document.dispatchEvent(new Event('focusin'));
    },
    blur(): void {
      focus.withinPage = false;
      document.activeElement = null;
    },
    openKeyboard(panOffset: number): void {
      visualViewport.height = 400;
      visualViewport.offsetTop = panOffset;
      visualViewport.dispatchEvent(new Event('resize'));
    },
    closeKeyboard(): void {
      visualViewport.height = LAYOUT_HEIGHT;
      visualViewport.offsetTop = 0;
      visualViewport.dispatchEvent(new Event('resize'));
    },
    /** A drag from `target` by `distance`, down positive, and whether it was cancelled. */
    drag(distance: number, target: object): boolean {
      document.dispatchEvent(touch('touchstart', 300, target));
      const move = touch('touchmove', 300 + distance, target);
      document.dispatchEvent(move);
      document.dispatchEvent(touch('touchend', 300 + distance, target));
      return move.defaultPrevented;
    },
    tap(target: object): void {
      document.dispatchEvent(touch('touchstart', 300, target));
      document.dispatchEvent(touch('touchend', 300, target));
    },
  };
}

/** A touch event on `target`, which Node's flat event targets cannot reach by dispatch. */
function touch(type: string, clientY: number, target: object): Event {
  const event = Object.assign(new Event(type, { cancelable: true }), { touches: [{ clientY }] });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

describe('pinPageAboveKeyboard', () => {
  it('As a visitor typing in the page, I see the page pinned to the visible area, and back at its top once the keyboard closes', () => {
    // Given: the field has focus.
    const fake = createFakePage();
    onTestFinished(fake.start());
    fake.focusField();

    // When: the keyboard opens and Safari pans the page, then the field blurs and the keyboard closes.
    fake.openKeyboard(120);
    const whileOpen = Object.fromEntries(fake.written);
    fake.blur();
    fake.closeKeyboard();

    // Then
    expect(whileOpen).toEqual({ 'data-keyboard-open': '', '--visible-height': '400px', '--pan-offset': '120px' });
    expect(fake.written.size).toBe(0);
    expect(fake.scroller.scrollTop).toBe(0);
    expect(fake.log).toEqual(['field scrolled into view', 'window scrolled to top']);
  });

  it('As a visitor with the keyboard open, I cannot drag the page from outside the scroll box, and a tap on text closes the keyboard', () => {
    // Given: the keyboard is open for the field.
    const fake = createFakePage();
    onTestFinished(fake.start());
    fake.focusField();
    fake.openKeyboard(120);

    // When: a drag starts on the header, then a tap lands on plain text in the scroll box.
    const cancelled = fake.drag(-40, fake.header);
    fake.tap(fake.text);

    // Then
    expect(cancelled).toBe(true);
    expect(fake.log).toContain('field blurred');
  });

  it('As a visitor with the keyboard open, I can drag a list portaled out of the page box', () => {
    // Given: the keyboard is open for the field.
    const fake = createFakePage();
    onTestFinished(fake.start());
    fake.focusField();
    fake.openKeyboard(120);

    // When: a drag starts in the field's suggestion list, which renders outside the page box.
    const cancelled = fake.drag(-40, fake.list);

    // Then
    expect(cancelled).toBe(false);
  });

  it("As a visitor who typed in an overlay's field, I find the window back at its top once the keyboard closes, and the scroll box where I left it", () => {
    // Given: the keyboard is open for a field in an overlay.
    const fake = createFakePage();
    onTestFinished(fake.start());
    fake.focusOverlayField();
    fake.openKeyboard(120);

    // When: the field blurs and the keyboard closes.
    fake.blur();
    fake.closeKeyboard();

    // Then
    expect(fake.log).toEqual(['window scrolled to top']);
    expect(fake.scroller.scrollTop).toBe(40);
  });

  it("As a visitor who moves to an overlay's field, I get none of the pinning: nothing written, no drag cancelled, no blur", () => {
    // Given: the page is pinned for its field.
    const fake = createFakePage();
    onTestFinished(fake.start());
    fake.focusField();
    fake.openKeyboard(120);

    // When: focus moves to a field in an overlay, the keyboard stays, and the visitor drags and taps.
    fake.focusOverlayField();
    fake.openKeyboard(200);
    const cancelled = fake.drag(-40, fake.header);
    fake.tap(fake.text);

    // Then
    expect(fake.written.size).toBe(0);
    expect(cancelled).toBe(false);
    expect(fake.log).not.toContain('overlay field blurred');
  });

  it('As the page that started it, I stop it and it clears what it wrote and acts on nothing after', () => {
    // Given: the page is pinned for its field.
    const fake = createFakePage();
    const stop = fake.start();
    fake.focusField();
    fake.openKeyboard(120);

    // When: it is stopped, and the keyboard pans on and the visitor drags from the header.
    stop();
    fake.openKeyboard(200);
    const cancelled = fake.drag(-40, fake.header);

    // Then
    expect(fake.written.size).toBe(0);
    expect(cancelled).toBe(false);
  });
});

describe('isKeyboardOpen', () => {
  it.each([
    { visibleHeight: 720, open: false },
    { visibleHeight: 719, open: true },
  ])(
    'As the helper, I judge a visible height of $visibleHeight under an 800px layout as open: $open',
    ({ visibleHeight, open }) => {
      // Given: the layout height.
      const layoutHeight = LAYOUT_HEIGHT;

      // When
      const judged = isKeyboardOpen(visibleHeight, layoutHeight);

      // Then
      expect(judged).toBe(open);
    },
  );
});

describe('getDragVerdict', () => {
  const MIDDLE = { scrollTop: 200, clientHeight: 500, scrollHeight: 1000 };
  const TOP = { ...MIDDLE, scrollTop: 0 };
  // Half a pixel short of the foot, as a fractional scroll position leaves it.
  const FOOT = { ...MIDDLE, scrollTop: 499.5 };

  it.each([
    { name: 'a jitter under the threshold', distance: 9, origin: 'scroller', scroller: MIDDLE, verdict: null },
    { name: 'a drag from the page outside the box', distance: 10, origin: 'page', scroller: MIDDLE, verdict: 'cancel' },
    { name: 'a pull down at the top', distance: 10, origin: 'scroller', scroller: TOP, verdict: 'cancel' },
    { name: 'a push up at the foot', distance: -10, origin: 'scroller', scroller: FOOT, verdict: 'cancel' },
    { name: 'a drag the box can scroll', distance: 10, origin: 'scroller', scroller: MIDDLE, verdict: 'allow' },
  ] as const)('As the helper, I judge $name as $verdict', ({ distance, origin, scroller, verdict }) => {
    // Given: a drag in the row.
    const drag = { distance, origin, scroller };

    // When
    const judged = getDragVerdict(drag);

    // Then
    expect(judged).toBe(verdict);
  });
});

describe('isBlurringTap', () => {
  const plain = { closest: () => null };
  const control = { closest: () => control };

  it.each([
    { name: 'a tap on plain content', verdict: null, target: plain, blurs: true },
    { name: 'a tap on a control', verdict: null, target: control, blurs: false },
    { name: 'the end of a judged drag', verdict: 'allow' as const, target: plain, blurs: false },
  ])('As the helper, I judge whether $name blurs: $blurs', ({ verdict, target, blurs }) => {
    // Given: the touch in the row.
    const touchEnd = { verdict, target };

    // When
    const judged = isBlurringTap(touchEnd.verdict, touchEnd.target);

    // Then
    expect(judged).toBe(blurs);
  });
});
