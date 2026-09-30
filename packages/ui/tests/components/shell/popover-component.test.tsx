// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell's Popover (components/shell/Popover.tsx) with stand-in content:
// its trigger, surface, backdrop, lazy content and dismissal.

import { createSignal, lazy } from 'solid-js';
import { cleanup } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_MS, Popover, usePopover } from '../../../src/components/shell/Popover.js';
import { mouseClick, pointerPress, renderComponent, resetStores, settle, waitForContent } from '../../helpers/solid.js';
import { byId, must } from '../../support.js';

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
const isOpen = (): boolean => surface().classList.contains('open');

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
    expect(surface().querySelector('.popover-body > .popover-loading')).not.toBeNull();
    release();
    const body = await waitForContent('test-popover');
    expect(body.querySelector('#body')).not.toBeNull();
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
    expect(backdrop.classList.contains('open')).toBe(false);

    // When
    mouseClick(trigger());
    await settle();

    // Then
    expect(backdrop.classList.contains('open')).toBe(true);

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

  it('As a user who reopens it while it fades out, the content stays', async () => {
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

    // Then
    expect(isOpen()).toBe(true);
    expect(body.isConnected).toBe(true);
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
    expect(byId('first').classList.contains('open')).toBe(false);
    expect(byId('second').classList.contains('open')).toBe(true);
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
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { root: 'popover:test-popover' });

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
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { root: 'popover:test-popover' });
  });

  it('As a user, something inside the content takes Escape first', async () => {
    // Given
    let taking = true;
    function EscapeTaker() {
      usePopover().onEscape(() => taking);
      return <button id="taker" type="button" />;
    }
    const { Content, release } = chunk(EscapeTaker);
    release();
    renderPopover(Content);
    await settle();
    mouseClick(trigger());
    await waitForContent('test-popover');

    // When
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();

    // Then
    expect(isOpen()).toBe(true);

    // When
    taking = false;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();

    // Then
    expect(isOpen()).toBe(false);
  });
});
