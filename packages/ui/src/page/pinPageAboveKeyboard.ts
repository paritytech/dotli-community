// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Keeps a page box in place while mobile Safari's on-screen keyboard is open for a field inside it. Safari pans the
// page to show the field and lets a drag pan it further, so the page box reports what is visible for its CSS to shift
// and cut the page by, and a drag its scroll box cannot take is cancelled.

/** Whether a drag may go on. */
type DragVerdict = 'cancel' | 'allow';

/** The box that carries the keyboard state for its CSS to read. */
type PageBox = Pick<HTMLElement, 'setAttribute' | 'removeAttribute'> & {
  matches(selectors: string): boolean;
  style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>;
};

type ScrollBox = Pick<HTMLElement, 'contains' | 'scrollTop' | 'clientHeight' | 'scrollHeight'>;

/** What a tap ended on, asked whether a control holds it. */
type TapTarget = { closest(selectors: string): unknown };

/** Not every element can blur, but every one the keyboard opens for can. */
type FocusedElement = Pick<Element, 'scrollIntoView'> & Partial<Pick<HTMLElement, 'blur'>>;

type Params = {
  page: PageBox;
  /** The box inside `page` that scrolls its content. */
  scroller: ScrollBox;
  /** The page's own by default. Without one there is no keyboard to follow. */
  visualViewport?: Pick<VisualViewport, 'addEventListener' | 'height' | 'offsetTop'> | null;
  /** The page's own by default. */
  window?: Pick<Window, 'innerHeight' | 'scrollTo'>;
  /** The page's own by default. */
  document?: Pick<Document, 'addEventListener'> & { readonly activeElement: FocusedElement | null };
};

type GetDragVerdictParams = {
  /** How far the touch has moved since it started, down positive. */
  distance: number;
  startedInScroller: boolean;
  scroller: Pick<ScrollBox, 'scrollTop' | 'clientHeight' | 'scrollHeight'>;
};

const KEYBOARD_ATTRIBUTE = 'data-keyboard-open';
const VISIBLE_HEIGHT = '--visible-height';
const PAN_OFFSET = '--pan-offset';
// Safari's own toolbars change the visible height by less than a keyboard does.
const KEYBOARD_MIN_HEIGHT = 80;
// A tap's jitter stays under it, so a tap is never judged as a drag.
const DRAG_THRESHOLD = 10;
const CONTROLS = 'input, textarea, select, button, a, label, [role=option]';

/**
 * Pins `page` while the keyboard is open for a field inside it, and returns the stop, which removes every listener
 * and clears what it wrote. The stop is safe to call twice.
 *
 * While pinned, `page` carries `data-keyboard-open` and the custom properties `--visible-height` and `--pan-offset`,
 * the visual viewport's height and offset in px. Once the keyboard closes, the window and `scroller` are back at their
 * top.
 */
export function pinPageAboveKeyboard({
  page,
  scroller,
  visualViewport = globalThis.visualViewport,
  window = globalThis.window,
  document = globalThis.document,
}: Params): () => void {
  if (visualViewport === null) {
    return () => undefined;
  }
  // The hoisted steps below do not see the parameter narrowed.
  const viewport = visualViewport;
  const controller = new AbortController();
  const { signal } = controller;
  let pinned = false;
  let startY = 0;
  let verdict: DragVerdict | null = null;

  viewport.addEventListener('resize', follow, { signal });
  viewport.addEventListener('scroll', follow, { signal });
  document.addEventListener(
    'focusin',
    () => {
      // Focus on a field outside the page box, such as an overlay's, leaves the keyboard to that field.
      if (!page.matches(':focus-within')) {
        unpin();
        return;
      }
      follow();
    },
    { signal },
  );
  document.addEventListener(
    'touchstart',
    event => {
      startY = event.touches[0]?.clientY ?? 0;
      verdict = null;
    },
    { passive: true, signal },
  );
  // A drag the scroll box cannot take is cancelled, so Safari never pans the page. iOS makes a document's touch
  // listeners passive unless told otherwise, and a passive one cannot cancel.
  document.addEventListener(
    'touchmove',
    event => {
      if (!pinned) {
        return;
      }
      verdict ??= getDragVerdict({
        distance: (event.touches[0]?.clientY ?? startY) - startY,
        startedInScroller: isElement(event.target) && scroller.contains(event.target),
        scroller,
      });
      if (verdict === 'cancel') {
        event.preventDefault();
      }
    },
    { passive: false, signal },
  );
  // A tap outside any control closes the keyboard, whatever iOS deems clickable.
  document.addEventListener(
    'touchend',
    event => {
      if (pinned && isElement(event.target) && isBlurringTap(verdict, event.target)) {
        document.activeElement?.blur?.();
      }
    },
    { signal },
  );

  return () => {
    controller.abort();
    unpin();
  };

  function follow(): void {
    if (!isKeyboardOpen(viewport.height, window.innerHeight)) {
      if (pinned) {
        // Safari can leave the page scrolled once the keyboard goes, and a clipped root gives the user no way back.
        window.scrollTo(0, 0);
        scroller.scrollTop = 0;
      }
      unpin();
      return;
    }
    const focusedInside = page.matches(':focus-within');
    // A blur keeps the page pinned until the keyboard has gone, so the page holds still while it slides away.
    if (!pinned && !focusedInside) {
      return;
    }
    pinned = true;
    page.setAttribute(KEYBOARD_ATTRIBUTE, '');
    page.style.setProperty(VISIBLE_HEIGHT, `${String(viewport.height)}px`);
    page.style.setProperty(PAN_OFFSET, `${String(viewport.offsetTop)}px`);
    if (focusedInside) {
      document.activeElement?.scrollIntoView({ block: 'nearest' });
    }
  }

  function unpin(): void {
    pinned = false;
    page.removeAttribute(KEYBOARD_ATTRIBUTE);
    page.style.removeProperty(VISIBLE_HEIGHT);
    page.style.removeProperty(PAN_OFFSET);
  }
}

/** Whether the on-screen keyboard is open, judged by how much shorter the visible area is than the layout. */
export function isKeyboardOpen(visibleHeight: number, layoutHeight: number): boolean {
  return visibleHeight < layoutHeight - KEYBOARD_MIN_HEIGHT;
}

/**
 * Judges a drag once it has moved past the threshold, `null` before. A drag is cancelled when the scroll box cannot
 * take it: it started outside the box, or it pulls past the box's top or pushes past its foot.
 */
export function getDragVerdict({ distance, startedInScroller, scroller }: GetDragVerdictParams): DragVerdict | null {
  if (Math.abs(distance) < DRAG_THRESHOLD) {
    return null;
  }
  const atTop = scroller.scrollTop <= 0;
  // A fractional scroll position can stop a pixel short of the foot.
  const atFoot = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
  if (!startedInScroller || (distance > 0 && atTop) || (distance < 0 && atFoot)) {
    return 'cancel';
  }
  return 'allow';
}

/** Whether a touch that ended on `target` was a tap that should close the keyboard: no drag, and no control under it. */
export function isBlurringTap(verdict: DragVerdict | null, target: TapTarget): boolean {
  return verdict === null && target.closest(CONTROLS) === null;
}

function isElement(target: EventTarget | null): target is Element {
  return target !== null && 'closest' in target;
}
