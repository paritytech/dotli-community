// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell's Popover (components/shell/Popover.tsx) with stand-in content:
// its trigger, surface, backdrop, lazy content and dismissal.

import { createSignal, lazy } from 'solid-js';
import { cleanup } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_MS, Popover, SHEET_EXIT_MS, usePopover } from '../../../src/components/shell/Popover.js';
import { mouseClick, pointerPress, renderComponent, resetStores, settle, waitForContent } from '../../helpers/solid.js';
import { byId, byTestId, must } from '../../support.js';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../../../metrics/src/sentry.js', () => sentry);

/** A content chunk whose import waits for `release`, and can fail. */
function chunk(markup: () => ReturnType<typeof Body>, { fail = false } = {}) {
  let release = (): void => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const importer = vi.fn(async () => {
    await gate;
    if (fail) {
      throw new Error('chunk failed');
    }
    return { Content: markup };
  });
  return { Content: lazy(importer, { export: 'Content' }), release, importer };
}

function Body() {
  const popover = usePopover();
  return (
    <div id="body">
      <button
        id="inside"
        type="button"
        onClick={() => {
          popover.close();
        }}
      >
        Close from inside
      </button>
    </div>
  );
}

function stubViewport(narrow: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 560px)' && narrow,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

function renderPopover(
  content: ReturnType<typeof chunk>['Content'],
  extra: Partial<Parameters<typeof Popover>[0]> = {},
): { unmount: () => void } {
  return renderComponent(() => (
    <div>
      <Popover
        id="test-popover"
        title="Test"
        content={content}
        trigger={t => (
          <button {...t} id="test-trigger" type="button">
            Open
          </button>
        )}
        {...extra}
      />
      <button id="outside" type="button">
        Outside
      </button>
    </div>
  ));
}

const surface = (): HTMLElement => byId('test-popover');
const trigger = (): HTMLElement => byId('test-trigger');
const isOpen = (): boolean => surface().hasAttribute('data-open');

beforeEach(() => {
  stubViewport(false);
  sentry.captureException.mockReset();
  vi.stubGlobal('requestIdleCallback', () => 1);
  vi.stubGlobal('cancelIdleCallback', () => undefined);
});

afterEach(() => {
  // Before the globals go: disposing a popover cancels its idle preload.
  cleanup();
  resetStores();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Popover', () => {
  it('As a user, the trigger opens a dialog surface in the body and says so', async () => {
    // Given
    const { Content, release } = chunk(Body);
    renderPopover(Content);
    await settle();
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-controls')).toBe('test-popover');
    expect(surface().parentElement).toBe(document.body);
    expect(surface().getAttribute('role')).toBe('dialog');
    expect(surface().getAttribute('aria-label')).toBe('Test');

    // When
    mouseClick(trigger());
    await settle();

    // Then: open, loading until the chunk arrives, then the content.
    expect(isOpen()).toBe(true);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(surface().querySelector('[data-testid="popover-body"] > [data-testid="popover-loading"]')).not.toBeNull();
    release();
    const body = await waitForContent('test-popover');
    expect(body.querySelector('#body')).not.toBeNull();
  });

  it('As a keyboard user, focus moves to the content once it has loaded, not left on the empty surface', async () => {
    // Given
    const { Content, release } = chunk(Body);
    renderPopover(Content);
    await settle();

    // When: opened before the chunk is in.
    mouseClick(trigger());
    await settle();
    expect(document.activeElement).toBe(surface());
    release();
    await waitForContent('test-popover');

    // Then
    expect(document.activeElement).toBe(byId('inside'));
  });

  it('As a user who moved focus while the content loaded, focus stays where I put it', async () => {
    // Given
    const { Content, release } = chunk(Body);
    renderPopover(Content);
    await settle();
    mouseClick(trigger());
    await settle();

    // When
    trigger().focus();
    release();
    await waitForContent('test-popover');

    // Then
    expect(document.activeElement).toBe(trigger());
  });

  it('As a user, Escape, a press outside and a second click on the trigger each close it', async () => {
    // Given
    const { Content, release } = chunk(Body);
    release();
    renderPopover(Content);
    await settle();

    for (const close of [
      () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      },
      () => {
        pointerPress(byId('outside'));
      },
      () => {
        mouseClick(trigger());
      },
    ]) {
      mouseClick(trigger());
      await waitForContent('test-popover');
      expect(isOpen()).toBe(true);

      // When
      close();
      await settle();

      // Then
      expect(isOpen()).toBe(false);
    }
  });

  it('As a keyboard user, Escape closes it and hands focus back to the trigger', async () => {
    // Given
    const { Content, release } = chunk(Body);
    release();
    renderPopover(Content);
    await settle();
    mouseClick(trigger());
    await waitForContent('test-popover');

    // When
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it('As a user, a backdrop dims the page under the popover, and a press on it closes the popover', async () => {
    // Given
    const { Content, release } = chunk(Body);
    release();
    renderPopover(Content, { backdrop: true });
    await settle();
    const backdrop = byId('test-popover-backdrop');
    expect(backdrop.hasAttribute('data-open')).toBe(false);

    // When
    mouseClick(trigger());
    await settle();

    // Then
    expect(backdrop.hasAttribute('data-open')).toBe(true);

    // When
    pointerPress(backdrop);
    mouseClick(backdrop);
    await settle();

    // Then
    expect(isOpen()).toBe(false);
  });

  it('As a page, it can open and close the popover through open and onOpenChange', async () => {
    // Given
    const { Content, release } = chunk(Body);
    release();
    const [open, setOpen] = createSignal(false);
    const changes: boolean[] = [];
    renderPopover(Content, {
      get open() {
        return open();
      },
      onOpenChange: next => {
        changes.push(next);
        setOpen(next);
      },
    });
    await settle();

    // When
    setOpen(true);
    await settle();

    // Then
    expect(isOpen()).toBe(true);

    // When: the content closes it.
    mouseClick(must((await waitForContent('test-popover')).querySelector<HTMLElement>('#inside'), '#inside'));
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(changes).toEqual([false]);
  });

  it('As a user, the content goes after the close transition, and each opening mounts it afresh', async () => {
    // Given
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { Content, release } = chunk(Body);
    release();
    renderPopover(Content);
    await settle();
    mouseClick(trigger());
    const first = must((await waitForContent('test-popover')).querySelector('#body'), '#body');

    // When
    mouseClick(trigger());
    await settle();

    // Then: still there for the fade-out, gone after it.
    expect(first.isConnected).toBe(true);
    vi.advanceTimersByTime(EXIT_MS);
    await settle();
    expect(first.isConnected).toBe(false);

    // When
    mouseClick(trigger());
    const second = must((await waitForContent('test-popover')).querySelector('#body'), '#body');

    // Then
    expect(second).not.toBe(first);
  });

  it('As a user who reopens it while it fades out, the content shows afresh and stays', async () => {
    // Given
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { Content, release } = chunk(Body);
    release();
    renderPopover(Content);
    await settle();
    mouseClick(trigger());
    const body = must((await waitForContent('test-popover')).querySelector('#body'), '#body');

    // When
    mouseClick(trigger());
    await settle();
    vi.advanceTimersByTime(EXIT_MS / 2);
    mouseClick(trigger());
    await settle();
    vi.advanceTimersByTime(EXIT_MS);
    await settle();

    // Then: the opening's own content, still there once the old fade-out ended.
    expect(isOpen()).toBe(true);
    expect(body.isConnected).toBe(false);
    expect(surface().querySelector('#body')).not.toBeNull();
  });

  it('As a user whose pointer leaves the button between closing and reopening, the reopened popover keeps its content', async () => {
    // Given
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { Content, release } = chunk(Body);
    release();
    renderPopover(Content);
    await settle();
    mouseClick(trigger());
    await waitForContent('test-popover');

    // When: closed, the pointer leaves and comes back, and reopens it
    // within the fade-out (a touch fires pointerleave before each click).
    mouseClick(trigger());
    await settle();
    trigger().dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'touch' }));
    vi.advanceTimersByTime(150);
    mouseClick(trigger());
    await settle();
    vi.advanceTimersByTime(EXIT_MS * 2);
    await settle();

    // Then
    expect(isOpen()).toBe(true);
    expect(surface().querySelector('#body')).not.toBeNull();
  });

  it('As the shell, a pointer passing over a button whose popover does not open on hover leaves no timer', async () => {
    // Given
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { Content } = chunk(Body);
    renderPopover(Content);
    await settle();

    // When
    trigger().dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    trigger().dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));

    // Then
    expect(vi.getTimerCount()).toBe(0);
  });

  it('As a user, a second popover opening closes the first', async () => {
    // Given
    const a = chunk(Body);
    const b = chunk(() => <p id="other">Other</p>);
    a.release();
    b.release();
    renderComponent(() => (
      <div>
        <Popover id="first" title="First" content={a.Content} trigger={t => <button {...t} id="first-trigger" />} />
        <Popover id="second" title="Second" content={b.Content} trigger={t => <button {...t} id="second-trigger" />} />
      </div>
    ));
    await settle();
    mouseClick(byId('first-trigger'));
    await waitForContent('first');

    // When
    pointerPress(byId('second-trigger'));
    mouseClick(byId('second-trigger'));
    await waitForContent('second');

    // Then
    expect(byId('first').hasAttribute('data-open')).toBe(false);
    expect(byId('second').hasAttribute('data-open')).toBe(true);
  });

  it('As the shell, a popover that was never opened keeps no timer running', async () => {
    // Given
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { Content } = chunk(Body);

    // When
    renderPopover(Content);
    await settle();

    // Then
    expect(vi.getTimerCount()).toBe(0);
  });

  it('As the shell, the content chunk preloads when the browser is idle', async () => {
    // Given
    let idle: (() => void) | undefined;
    vi.stubGlobal('requestIdleCallback', (run: () => void) => {
      idle = run;
      return 1;
    });
    const { Content, importer } = chunk(Body);

    // When
    renderPopover(Content);
    await settle();

    // Then
    expect(importer).not.toHaveBeenCalled();
    idle?.();
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('As a user, content that cannot load is reported once and the popover closes; the next opening loads it again', async () => {
    // Given
    const failing = chunk(Body, { fail: true });
    failing.release();
    renderPopover(failing.Content);
    await settle();

    // When
    mouseClick(trigger());
    await settle();
    expect(isOpen()).toBe(true);
    await vi.waitFor(() => {
      expect(sentry.captureException).toHaveBeenCalled();
    });
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      flow: 'ui',
      step: 'root_render',
      tags: { root: 'popover:test-popover' },
    });

    // When
    mouseClick(trigger());
    await vi.waitFor(() => {
      expect(failing.importer).toHaveBeenCalledTimes(2);
    });
  });

  it('As a user, content that throws is reported once and the popover closes', async () => {
    // Given
    const throwing = chunk(() => {
      throw new Error('render failed');
    });
    throwing.release();
    renderPopover(throwing.Content);
    await settle();

    // When
    mouseClick(trigger());
    await settle();
    expect(isOpen()).toBe(true);
    await vi.waitFor(() => {
      expect(sentry.captureException).toHaveBeenCalled();
    });
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      flow: 'ui',
      step: 'root_render',
      tags: { root: 'popover:test-popover' },
    });
  });

  it('As a phone user, a popover opens as a modal bottom sheet with a title and a close button', async () => {
    // Given
    stubViewport(true);
    const { Content, release } = chunk(Body);
    release();
    renderPopover(Content, { backdrop: true });
    await settle();

    // When
    mouseClick(trigger());
    await waitForContent('test-popover');

    // Then
    expect(surface().hasAttribute('data-sheet')).toBe(true);
    expect(byId('test-popover-backdrop').hasAttribute('data-sheet')).toBe(true);
    expect(surface().getAttribute('aria-modal')).toBe('true');
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(true);
    expect(byId('test-popover-backdrop').hasAttribute('data-open')).toBe(true);
    const header = must(
      surface().querySelector<HTMLElement>(':scope > [data-testid="popover-sheet-header"]'),
      'sheet header',
    );
    expect(byTestId('popover-sheet-title', header).textContent).toBe('Test');

    // When
    mouseClick(must(header.querySelector<HTMLElement>('[data-testid="popover-sheet-close"]'), 'close'));
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false);
  });

  it('As a phone user, a closing sheet keeps its content until it has slid out', async () => {
    // Given
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubViewport(true);
    const { Content, release } = chunk(Body);
    release();
    renderPopover(Content);
    await settle();
    mouseClick(trigger());
    await waitForContent('test-popover');

    // When
    mouseClick(must(surface().querySelector<HTMLElement>('[data-testid="popover-sheet-close"]'), 'close'));
    await settle();
    vi.advanceTimersByTime(EXIT_MS);
    await settle();

    // Then: longer than an anchored popover's fade.
    expect(surface().querySelector('#body')).not.toBeNull();
    vi.advanceTimersByTime(SHEET_EXIT_MS - EXIT_MS);
    await settle();
    expect(surface().querySelector('#body')).toBeNull();
  });

  it('As a phone user, a resize past the breakpoint leaves the open sheet a sheet, and the next opening follows the viewport', async () => {
    // Given
    stubViewport(true);
    const { Content, release } = chunk(Body);
    release();
    renderPopover(Content);
    await settle();
    mouseClick(trigger());
    await waitForContent('test-popover');

    // When
    stubViewport(false);
    window.dispatchEvent(new Event('resize'));
    await settle();

    // Then
    expect(surface().hasAttribute('data-sheet')).toBe(true);

    // When
    mouseClick(surface().querySelector<HTMLElement>('[data-testid="popover-sheet-close"]') ?? surface());
    await settle();
    mouseClick(trigger());
    await settle();

    // Then
    expect(surface().hasAttribute('data-sheet')).toBe(false);
    expect(surface().querySelector('[data-testid="popover-sheet-header"]')).toBeNull();
  });

  describe('swipe', () => {
    /** A drag on `el` from y 100 by `dy` pixels over `ms` milliseconds. */
    function drag(el: HTMLElement, dy: number, ms: number): void {
      const now = vi.spyOn(performance, 'now');
      now.mockReturnValue(1000);
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientY: 100, button: 0 }));
      now.mockReturnValue(1000 + ms);
      el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientY: 100 + dy }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientY: 100 + dy }));
      now.mockRestore();
    }

    async function openSheet(): Promise<HTMLElement> {
      stubViewport(true);
      const { Content, release } = chunk(Body);
      release();
      renderPopover(Content);
      await settle();
      mouseClick(trigger());
      await waitForContent('test-popover');
      vi.spyOn(surface(), 'offsetHeight', 'get').mockReturnValue(400);
      return must(surface().querySelector<HTMLElement>('[data-testid="popover-sheet-header"]'), 'header');
    }

    it('As a phone user, a slow swipe down past 30% of the sheet closes it', async () => {
      const header = await openSheet();
      drag(header, 130, 1000);
      await settle();
      expect(isOpen()).toBe(false);
    });

    it('As a phone user, a quick flick down closes the sheet', async () => {
      const header = await openSheet();
      drag(header, 60, 50);
      await settle();
      expect(isOpen()).toBe(false);
    });

    it('As a phone user whose tap on the header jitters a few pixels, the sheet stays open', async () => {
      const header = await openSheet();
      drag(header, 4, 5);
      await settle();
      expect(isOpen()).toBe(true);
    });

    it('As a phone user, a short slow swipe springs the sheet back', async () => {
      const header = await openSheet();
      drag(header, 60, 1000);
      await settle();
      expect(isOpen()).toBe(true);
      expect(surface().style.transform).toBe('');
      expect(surface().hasAttribute('data-dragging')).toBe(false);
    });

    it('As a phone user scrolling the sheet, a drag on its content neither moves nor closes it', async () => {
      await openSheet();
      drag(must(surface().querySelector<HTMLElement>('#body'), '#body'), 300, 1000);
      await settle();
      expect(isOpen()).toBe(true);
      expect(surface().style.transform).toBe('');
    });
  });
  it('As a screen-reader user, a disclosure says only whether it is shown, and its plain content takes no focus', async () => {
    // Given
    function Text() {
      return <p id="text">Plain text</p>;
    }
    const { Content, release } = chunk(Text);
    release();
    renderPopover(Content, { disclosure: true });
    await settle();
    expect(trigger().hasAttribute('aria-haspopup')).toBe(false);
    expect(surface().hasAttribute('role')).toBe(false);
    expect(surface().hasAttribute('tabindex')).toBe(false);
    trigger().focus();

    // When
    mouseClick(trigger());
    await waitForContent('test-popover');

    // Then
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(trigger());
  });

  it('As a phone user, a disclosure opens as a sheet, a modal dialog like any other', async () => {
    // Given
    stubViewport(true);
    const { Content, release } = chunk(Body);
    release();
    renderPopover(Content, { disclosure: true });
    await settle();

    // When
    mouseClick(trigger());
    await waitForContent('test-popover');

    // Then: a dialog, and its trigger says so while it is one.
    expect(surface().getAttribute('role')).toBe('dialog');
    expect(surface().getAttribute('aria-modal')).toBe('true');
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('As a user, a popover anchored to its trigger opens under it', async () => {
    // Given
    const { Content, release } = chunk(Body);
    release();
    renderPopover(Content, { anchor: 'trigger' });
    await settle();
    vi.spyOn(trigger(), 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 10, 24, 20));

    // When
    mouseClick(trigger());
    await settle();

    // Then
    expect(surface().getAttribute('data-anchor')).toBe('trigger');
    expect(surface().style.top).toBe('36px');
    expect(surface().style.left).toBe('40px');
  });

  it('As a desktop user, a peeking popover under its trigger follows the trigger when the window resizes', async () => {
    // Given
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(hover: hover)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const { Content, release } = chunk(Body);
    release();
    renderPopover(Content, { anchor: 'trigger', openOnHover: true });
    await settle();
    const rect = vi.spyOn(trigger(), 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 10, 24, 20));
    trigger().dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    vi.advanceTimersByTime(200);
    await waitForContent('test-popover');
    expect(surface().style.left).toBe('40px');

    // When
    rect.mockReturnValue(new DOMRect(90, 10, 24, 20));
    window.dispatchEvent(new Event('resize'));
    await settle();

    // Then
    expect(surface().style.left).toBe('90px');
  });

  it('As a desktop user, resting the mouse on the trigger shows the popover without taking focus', async () => {
    // Given
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(hover: hover)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const { Content, release } = chunk(Body);
    release();
    renderPopover(Content, { openOnHover: true });
    await settle();
    byId('outside').focus();

    // When
    trigger().dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    vi.advanceTimersByTime(200);
    await waitForContent('test-popover');

    // Then
    expect(surface().hasAttribute('data-peek')).toBe(true);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(byId('outside'));

    // When
    trigger().dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    vi.advanceTimersByTime(100);
    await settle();

    // Then
    expect(surface().hasAttribute('data-peek')).toBe(false);
  });
});
