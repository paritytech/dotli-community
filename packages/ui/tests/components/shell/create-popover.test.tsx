// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPopover, type PopoverMode, type PopoverOptions } from '../../../src/components/shell/create-popover.js';
import { recordChainsButtonVisible, setBlockingModalActive, setTopbarVisible } from '../../../src/state/topbar.js';
import { renderComponent, resetStores, settle } from '../../helpers/solid.js';
import { byId, must } from '../../support.js';
import { stubPhoneViewport } from '../../helpers/viewport.js';

type Popover = ReturnType<typeof createPopover>;

type HarnessOptions = Omit<PopoverOptions, 'trigger' | 'surface' | 'mode'>;

/**
 * A trigger, a surface, and a button outside both. The popover and dialog
 * surfaces hold two buttons (after a link, with `link`); the menu surface
 * holds menu items (one of them hidden) and no tabbable element. `empty`
 * renders a surface with nothing focusable in it. The trigger has no click handler of its own, so a click
 * on it tests only what the popover does with it.
 */
function renderPopover(
  mode: PopoverOptions['mode'],
  options: HarnessOptions = {},
  { empty = false, link = false }: { empty?: boolean; link?: boolean } = {},
): Popover & { unmount: () => void } {
  let popover: Popover | undefined;
  function Harness() {
    let trigger: HTMLButtonElement | undefined;
    let surface: HTMLDivElement | undefined;
    popover = createPopover({
      ...options,
      mode,
      trigger: () => trigger,
      surface: () => surface,
    });
    const content = () => {
      if (empty) {
        return <span id="text">Text</span>;
      }
      if (mode === 'menu') {
        return (
          <>
            <button id="apple" role="menuitem" tabindex="-1">
              Apple
            </button>
            <button id="hidden-item" role="menuitem" tabindex="-1" hidden>
              Hidden
            </button>
            <button id="banana" role="menuitemradio" tabindex="-1">
              Banana
            </button>
            <button id="avocado" role="menuitem" tabindex="-1">
              Avocado
            </button>
            <button id="cherry" role="menuitem" tabindex="-1">
              Cherry
            </button>
          </>
        );
      }
      return (
        <>
          {link ? (
            <a id="link" href="#somewhere">
              Link
            </a>
          ) : null}
          <button id="first" type="button">
            First
          </button>
          <button id="last" type="button">
            Last
          </button>
        </>
      );
    };
    return (
      <div>
        <button
          id="trigger"
          type="button"
          ref={el => {
            trigger = el;
          }}
        >
          <span id="trigger-icon">T</span>
        </button>
        <div
          id="surface"
          tabindex="-1"
          ref={el => {
            surface = el;
          }}
        >
          {content()}
        </div>
        <button id="outside" type="button">
          Outside
        </button>
      </div>
    );
  }
  const { unmount } = renderComponent(() => <Harness />);
  return { ...must(popover, 'the popover'), unmount };
}

/** Whether a dialog holds the page's scroll lock. */
function scrollLocked(): boolean {
  return document.body.hasAttribute('data-scroll-locked');
}

async function openPopover(popover: Popover): Promise<void> {
  popover.setOpen(true);
  await settle();
  expect(popover.open()).toBe(true);
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

/**
 * A mouse press on `el`: pointerdown, then (as a browser does, moving focus
 * on mousedown unless the pointerdown was prevented) focus when `el` takes
 * it, then the click. Returns the click,
 * and whether it reached `el`'s own listeners.
 */
function pointerClick(el: HTMLElement): {
  click: MouseEvent;
  reached: boolean;
} {
  const down = new PointerEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    pointerType: 'mouse',
    button: 0,
  });
  el.dispatchEvent(down);
  if (el instanceof HTMLButtonElement && !down.defaultPrevented) {
    el.focus();
  }
  let reached = false;
  const onClick = (): void => {
    reached = true;
  };
  el.addEventListener('click', onClick);
  const click = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    detail: 1,
  });
  el.dispatchEvent(click);
  el.removeEventListener('click', onClick);
  return { click, reached };
}

afterEach(() => {
  resetStores();
  document.body.style.overflow = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createPopover, in every mode', () => {
  it.each<PopoverMode>(['popover', 'menu', 'dialog'])(
    'As a user, the trigger toggles the %s open and closed',
    async mode => {
      // Given
      const popover = renderPopover(mode);
      expect(popover.open()).toBe(false);

      // When / Then
      popover.toggle();
      await settle();
      expect(popover.open()).toBe(true);
      popover.toggle();
      await settle();
      expect(popover.open()).toBe(false);
    },
  );

  it.each<PopoverMode>(['popover', 'menu', 'dialog'])(
    'As a user, a press inside the %s or on the trigger leaves it open',
    async mode => {
      // Given
      const popover = renderPopover(mode);
      await openPopover(popover);

      // When
      byId('surface').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      byId('trigger-icon').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      byId('surface').click();
      await settle();

      // Then
      expect(popover.open()).toBe(true);
    },
  );

  it.each<PopoverMode>(['popover', 'dialog'])(
    'As a keyboard user, opening a %s focuses its first tabbable element',
    async mode => {
      // Given
      const popover = renderPopover(mode);
      byId('trigger').focus();

      // When
      await openPopover(popover);

      // Then
      expect(document.activeElement).toBe(byId('first'));
    },
  );

  it("As a keyboard user, opening a popover skips links, as Radix's FocusScope does, and any control that will not take focus", async () => {
    // Given
    const popover = renderPopover('popover', {}, { link: true });
    byId('first').focus = () => undefined;

    // When
    await openPopover(popover);

    // Then
    expect(document.activeElement).toBe(byId('last'));
  });

  it.each<PopoverMode>(['popover', 'dialog'])(
    'As a keyboard user, opening a %s with nothing tabbable in it focuses the surface itself',
    async mode => {
      // Given
      const popover = renderPopover(mode, {}, { empty: true });
      byId('trigger').focus();

      // When
      await openPopover(popover);

      // Then
      expect(document.activeElement).toBe(byId('surface'));
    },
  );

  it.each<PopoverMode>(['popover', 'menu', 'dialog'])(
    'As a keyboard user, Escape closes the %s and hands focus back to the trigger',
    async mode => {
      // Given
      const popover = renderPopover(mode);
      await openPopover(popover);
      expect(byId('surface').contains(document.activeElement)).toBe(true);

      // When
      press('Escape');
      await settle();

      // Then
      expect(popover.open()).toBe(false);
      expect(document.activeElement).toBe(byId('trigger'));
    },
  );

  it('As a Safari user, whose focus stays on the body after a click, Escape hands focus back to the trigger', async () => {
    // Given
    const popover = renderPopover('popover');
    await openPopover(popover);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    // When
    press('Escape');
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(document.activeElement).toBe(byId('trigger'));
  });

  it('As a keyboard user, Escape still closes a popover whose surface is not rendered', async () => {
    // Given
    let popover: Popover | undefined;
    renderComponent(() => {
      popover = createPopover({
        mode: 'popover',
        trigger: () => undefined,
        surface: () => undefined,
      });
      return null;
    });
    await openPopover(must(popover, 'the popover'));

    // When
    press('Escape');
    await settle();

    // Then
    expect(popover?.open()).toBe(false);
  });

  it.each<PopoverMode>(['popover', 'menu', 'dialog'])(
    'As a user, a blocking modal coming up closes the %s',
    async mode => {
      // Given
      const popover = renderPopover(mode);
      await openPopover(popover);

      // When
      setBlockingModalActive(true);
      await settle();

      // Then
      expect(popover.open()).toBe(false);
    },
  );

  it('As a user, a popover opened while a blocking modal is already up stays open until another one comes up', async () => {
    // Given
    setBlockingModalActive(true);
    const popover = renderPopover('popover');

    // When
    await openPopover(popover);

    // Then
    expect(popover.open()).toBe(true);
    setBlockingModalActive(false);
    await settle();
    expect(popover.open()).toBe(true);
    setBlockingModalActive(true);
    await settle();
    expect(popover.open()).toBe(false);
  });

  it('As a user, a popover opened while a blocking modal is up stays open across unrelated topbar writes', async () => {
    // Given
    setBlockingModalActive(true);
    const onClose = vi.fn();
    const popover = renderPopover('popover', { onClose });
    await openPopover(popover);

    // When: the auto-hide hides and reveals the topbar, and the chains
    // button shows, while the modal is still up.
    setTopbarVisible(false);
    await settle();
    setTopbarVisible(true);
    await settle();
    recordChainsButtonVisible(true);
    await settle();

    // Then
    expect(popover.open()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(0);
  });

  it('As the auth modal, a surface with closeOnBlockingModal false stays open when a blocking modal comes up', async () => {
    // Given
    const popover = renderPopover('dialog', { closeOnBlockingModal: false });
    await openPopover(popover);

    // When
    setBlockingModalActive(true);
    await settle();

    // Then
    expect(popover.open()).toBe(true);
  });

  it('As a user tapping into the product iframe, the window losing focus closes a closeOnBlur popover', async () => {
    // Given
    const popover = renderPopover('popover', { closeOnBlur: true });
    await openPopover(popover);

    // When
    window.dispatchEvent(new Event('blur'));
    await settle();

    // Then
    expect(popover.open()).toBe(false);
  });

  it('As a user, the window losing focus leaves a popover without closeOnBlur open', async () => {
    // Given
    const popover = renderPopover('popover');
    await openPopover(popover);

    // When: the window blurs, which blurs the focused element with no
    // element to receive focus.
    (document.activeElement as HTMLElement).blur();
    window.dispatchEvent(new Event('blur'));
    await settle();

    // Then
    expect(popover.open()).toBe(true);
  });

  it('As a component, onClose hears every close, whatever closed it, and never an open', async () => {
    // Given
    const onClose = vi.fn();
    const popover = renderPopover('popover', { closeOnBlur: true, onClose });
    const closers = [
      () => pointerClick(byId('outside')),
      () => {
        byId('outside').focus();
      },
      () => press('Escape'),
      () => window.dispatchEvent(new Event('blur')),
      () => {
        setBlockingModalActive(true);
      },
      () => {
        popover.setOpen(false);
      },
      () => {
        popover.toggle();
      },
      () => {
        popover.onItemChosen();
      },
    ];

    for (const [i, close] of closers.entries()) {
      // When
      setBlockingModalActive(false);
      await openPopover(popover);
      close();
      await settle();

      // Then
      expect(popover.open()).toBe(false);
      expect(onClose).toHaveBeenCalledTimes(i + 1);
    }
    popover.setOpen(false);
    expect(onClose).toHaveBeenCalledTimes(closers.length);
  });

  it.each<PopoverMode>(['popover', 'menu', 'dialog'])(
    'As a page, unmounting an open %s removes every listener it added and unlocks scroll',
    async mode => {
      // Given
      const onClose = vi.fn();
      const added: [EventTarget, string, unknown][] = [];
      const removed: [EventTarget, string, unknown][] = [];
      for (const target of [document, window]) {
        const add = target.addEventListener.bind(target);
        const remove = target.removeEventListener.bind(target);
        vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, opts) => {
          added.push([target, type, listener]);
          add(type, listener, opts);
        });
        vi.spyOn(target, 'removeEventListener').mockImplementation((type, listener, opts) => {
          removed.push([target, type, listener]);
          remove(type, listener, opts);
        });
      }
      const popover = renderPopover(mode, { closeOnBlur: true, onClose });
      await openPopover(popover);

      // When
      popover.unmount();
      await settle();

      // Then
      const ours = added.filter(([, type]) => ['pointerdown', 'click', 'keydown', 'focusout', 'blur'].includes(type));
      expect(ours.length).toBeGreaterThan(0);
      for (const entry of ours) {
        expect(removed).toContainEqual(entry);
      }
      expect(scrollLocked()).toBe(false);
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      press('Escape');
      window.dispatchEvent(new Event('blur'));
      setBlockingModalActive(true);
      await settle();
      expect(onClose).not.toHaveBeenCalled();
    },
  );
});

describe('createPopover, popover mode (Radix Popover, non-modal)', () => {
  it('As a keyboard user, Tab and Shift+Tab loop inside the popover', async () => {
    // Given
    const popover = renderPopover('popover');
    await openPopover(popover);

    // When / Then
    byId('last').focus();
    let event = press('Tab');
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId('first'));
    event = press('Tab', { shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId('last'));
    byId('first').focus();
    event = press('Tab');
    expect(event.defaultPrevented).toBe(false);
    expect(popover.open()).toBe(true);
  });

  it('As a keyboard user, with trapFocus false Tab moves on from the last element', async () => {
    // Given
    const popover = renderPopover('popover', { trapFocus: false });
    await openPopover(popover);
    byId('last').focus();

    // When
    const event = press('Tab');

    // Then
    expect(event.defaultPrevented).toBe(false);
  });

  it('As a keyboard user on the trigger, Tab moves into the open popover', async () => {
    // Given
    const popover = renderPopover('popover');
    await openPopover(popover);
    byId('trigger').focus();

    // When
    const event = press('Tab');

    // Then
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId('first'));
  });

  it('As a keyboard user, focus leaving the trigger and the popover closes it and stays where it went', async () => {
    // Given
    const popover = renderPopover('popover');
    await openPopover(popover);

    // When
    byId('outside').focus();
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(document.activeElement).toBe(byId('outside'));
  });

  it('As a keyboard user, focus moving between the trigger and the popover leaves it open', async () => {
    // Given
    const popover = renderPopover('popover');
    await openPopover(popover);

    // When
    byId('trigger').focus();
    byId('last').focus();
    byId('surface').focus();
    await settle();

    // Then
    expect(popover.open()).toBe(true);
  });

  it('As a user, a click inside the popover that briefly blurs to the body leaves it open', async () => {
    // Given
    const popover = renderPopover('popover');
    await openPopover(popover);

    // When: Safari moves focus to the body on a click on a button.
    byId('last').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    (document.activeElement as HTMLElement).blur();
    byId('last').click();
    await settle();

    // Then
    expect(popover.open()).toBe(true);
  });

  it('As a user, an outside pointerdown closes the popover without handing focus back, so focus follows my click', async () => {
    // Given
    const popover = renderPopover('popover');
    await openPopover(popover);

    // When
    const { reached } = pointerClick(byId('outside'));
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(reached).toBe(true);
    expect(document.activeElement).toBe(byId('outside'));
  });

  it('As a user, an outside pointerdown on nothing focusable closes the popover and leaves focus on the body', async () => {
    // Given
    const popover = renderPopover('popover');
    await openPopover(popover);

    // When: the browser moves focus to the body.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    (document.activeElement as HTMLElement).blur();
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it.each([
    { phone: true, reached: false, title: 'on a phone, it never reaches the page' },
    { phone: false, reached: true, title: 'on a wide screen, it reaches the page' },
  ])('As a user, a mouse click outside a sheet-capable popover: $title', async ({ phone, reached: expected }) => {
    // Given
    stubPhoneViewport(phone);
    const popover = renderPopover('popover', { sheet: true });
    await openPopover(popover);

    // When
    const { reached } = pointerClick(byId('outside'));
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(reached).toBe(expected);
  });

  it('As a keyboard user, closing the popover from inside it hands focus back to the trigger', async () => {
    // Given
    const popover = renderPopover('popover');
    await openPopover(popover);
    byId('last').focus();

    // When
    popover.setOpen(false);
    await settle();

    // Then
    expect(document.activeElement).toBe(byId('trigger'));
  });
});

describe('createPopover, menu mode (Radix DropdownMenu, modal)', () => {
  async function openWithKey(key: string): Promise<Popover> {
    const popover = renderPopover('menu');
    byId('trigger').focus();
    const event = press(key);
    await settle();
    expect(popover.open()).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    return popover;
  }

  it.each(['Enter', ' ', 'ArrowDown'])(
    'As a keyboard user, %j on the trigger opens the menu and focuses the first item',
    async key => {
      // When
      await openWithKey(key);

      // Then
      expect(document.activeElement).toBe(byId('apple'));
    },
  );

  it('As a keyboard user, Enter on the trigger of an open menu closes it', async () => {
    // Given
    const popover = renderPopover('menu');
    await openPopover(popover);
    byId('trigger').focus();

    // When
    press('Enter');
    await settle();

    // Then
    expect(popover.open()).toBe(false);
  });

  it('As a mouse user whose click left focus on the trigger, opening the menu with a pointer moves focus to the menu content', async () => {
    // Given: a browser that focuses a button on click keeps focus on the
    // trigger through a pointer opening.
    const popover = renderPopover('menu');
    byId('trigger').focus();

    // When
    popover.toggle();
    await settle();

    // Then
    expect(document.activeElement).toBe(byId('surface'));
  });

  it('As a mouse user, opening the menu with a pointer focuses the menu content', async () => {
    // Given
    const popover = renderPopover('menu');

    // When
    popover.toggle();
    await settle();

    // Then
    expect(document.activeElement).toBe(byId('surface'));
  });

  it('As a keyboard user, ArrowDown and ArrowUp move between the visible items and loop', async () => {
    // Given
    await openWithKey('ArrowDown');

    // When / Then
    press('ArrowDown');
    expect(document.activeElement).toBe(byId('banana'));
    press('ArrowDown');
    press('ArrowDown');
    expect(document.activeElement).toBe(byId('cherry'));
    const event = press('ArrowDown');
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId('apple'));
    press('ArrowUp');
    expect(document.activeElement).toBe(byId('cherry'));
  });

  it('As a keyboard user, ArrowDown or ArrowUp on the menu content focuses the first or last item', async () => {
    // Given
    const popover = renderPopover('menu');
    await openPopover(popover);
    expect(document.activeElement).toBe(byId('surface'));

    // When / Then
    press('ArrowDown');
    expect(document.activeElement).toBe(byId('apple'));
    byId('surface').focus();
    press('ArrowUp');
    expect(document.activeElement).toBe(byId('cherry'));
  });

  it('As a keyboard user, Home and End jump to the first and last items', async () => {
    // Given
    await openWithKey('ArrowDown');

    // When / Then
    press('End');
    expect(document.activeElement).toBe(byId('cherry'));
    press('Home');
    expect(document.activeElement).toBe(byId('apple'));
  });

  it('As a keyboard user, typing a letter focuses the next item starting with it, cycling on repeats', async () => {
    // Given
    await openWithKey('ArrowDown');

    // When / Then
    press('c');
    expect(document.activeElement).toBe(byId('cherry'));
    press('A');
    expect(document.activeElement).toBe(byId('apple'));
    press('a');
    expect(document.activeElement).toBe(byId('avocado'));
    press('a');
    expect(document.activeElement).toBe(byId('apple'));
    press('z');
    expect(document.activeElement).toBe(byId('apple'));
  });

  it('As a mouse user, hovering an item focuses it', async () => {
    // Given
    const popover = renderPopover('menu');
    await openPopover(popover);

    // When
    byId('banana').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));

    // Then
    expect(document.activeElement).toBe(byId('banana'));
  });

  it('As a keyboard user, Tab is prevented, so focus stays in the menu', async () => {
    // Given
    const popover = await openWithKey('ArrowDown');

    // When
    const tab = press('Tab');
    const shiftTab = press('Tab', { shiftKey: true });
    await settle();

    // Then
    expect(tab.defaultPrevented).toBe(true);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(popover.open()).toBe(true);
    expect(document.activeElement).toBe(byId('apple'));
  });

  it('As a user, an outside pointerdown closes the menu and swallows that click, so it does not activate what is underneath', async () => {
    // Given
    const popover = renderPopover('menu');
    await openPopover(popover);
    const documentClicks = vi.fn();
    document.addEventListener('click', documentClicks);

    // When
    const { click, reached } = pointerClick(byId('outside'));
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(reached).toBe(false);
    expect(click.defaultPrevented).toBe(true);
    expect(documentClicks).not.toHaveBeenCalled();

    // When: the next click is a new one.
    byId('outside').click();

    // Then
    expect(documentClicks).toHaveBeenCalledTimes(1);
    document.removeEventListener('click', documentClicks);
  });

  it('As a user, an outside press on a menu does not move focus there: focus goes back to the trigger', async () => {
    // Given
    const popover = await openWithKey('ArrowDown');

    // When
    const down = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
    });
    byId('outside').dispatchEvent(down);
    await settle();

    // Then: the prevented pointerdown keeps the browser from focusing it.
    expect(down.defaultPrevented).toBe(true);
    expect(popover.open()).toBe(false);
    expect(document.activeElement).toBe(byId('trigger'));
  });

  it.each(['pointercancel', 'keydown'])(
    'As a user, an outside press that ends in a %s instead of a click does not swallow a later keyboard or programmatic click',
    async type => {
      // Given: a touch outside turns into a scroll, or a key is pressed.
      const popover = renderPopover('menu');
      await openPopover(popover);
      byId('outside').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      await settle();
      expect(popover.open()).toBe(false);
      document.dispatchEvent(new Event(type, { bubbles: true }));
      const clicks = vi.fn();
      byId('outside').addEventListener('click', clicks);

      // When
      byId('outside').click();

      // Then
      expect(clicks).toHaveBeenCalledTimes(1);
    },
  );

  it('As a mouse user, a keyboard opening undone before it rendered does not make my next pointer opening focus the first item', async () => {
    // Given: Enter opens the menu and something closes it in the same batch.
    const popover = renderPopover('menu');
    byId('trigger').focus();
    press('Enter');
    popover.setOpen(false);
    await settle();

    // When
    popover.toggle();
    await settle();

    // Then
    expect(document.activeElement).toBe(byId('surface'));
  });

  it('As a mouse user, a long outside press on a menu still has its click swallowed', async () => {
    // Given
    const popover = renderPopover('menu');
    await openPopover(popover);
    vi.useFakeTimers();
    try {
      byId('outside').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));

      // When: held for a second, then released.
      vi.advanceTimersByTime(1000);
      byId('outside').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
      let reached = false;
      byId('outside').addEventListener('click', () => {
        reached = true;
      });
      byId('outside').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));

      // Then
      expect(reached).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('As a user, an outside pointerdown whose click never comes does not swallow a later click', async () => {
    // Given: a press outside that turns into a scroll, so no click follows.
    const popover = renderPopover('menu');
    await openPopover(popover);
    byId('outside').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await settle();
    expect(popover.open()).toBe(false);

    // When
    const { reached } = pointerClick(byId('outside'));

    // Then
    expect(reached).toBe(true);
  });

  it('As a keyboard user, choosing an item closes the menu and hands focus back to the trigger', async () => {
    // Given
    const popover = await openWithKey('ArrowDown');
    press('ArrowDown');

    // When
    popover.onItemChosen();
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(document.activeElement).toBe(byId('trigger'));
  });

  it('As a phone user, a menu with sheet opens as a sheet, slides out as one, and the next opening follows the viewport', async () => {
    // Given
    const viewport = stubPhoneViewport(true);
    const popover = renderPopover('menu', { sheet: true });

    // When
    await openPopover(popover);

    // Then
    expect(popover.sheet()).toBe(true);

    // When: the window widens, then the menu closes
    viewport.set(false);
    popover.setOpen(false);
    await settle();

    // Then: it closes as the sheet it opened as
    expect(popover.sheet()).toBe(true);

    // When
    await openPopover(popover);

    // Then
    expect(popover.sheet()).toBe(false);
  });

  it('As a phone user, a menu without sheet still drops as a menu', async () => {
    // Given
    stubPhoneViewport(true);
    const popover = renderPopover('menu');

    // When
    await openPopover(popover);

    // Then
    expect(popover.sheet()).toBe(false);
  });
});

describe('createPopover, dialog mode (Radix Dialog, modal)', () => {
  it('As a keyboard user, Tab and Shift+Tab are trapped inside the dialog', async () => {
    // Given
    const popover = renderPopover('dialog');
    await openPopover(popover);

    // When / Then
    byId('last').focus();
    let event = press('Tab');
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId('first'));
    event = press('Tab', { shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId('last'));
    byId('first').focus();
    event = press('Tab');
    expect(event.defaultPrevented).toBe(false);
  });

  it('As a user, the page does not scroll while the dialog is open, and scrolls again after', async () => {
    // Given
    document.body.style.overflow = 'scroll';
    const popover = renderPopover('dialog');

    // When
    await openPopover(popover);

    // Then: locked through its own attribute, the page's inline style kept.
    expect(scrollLocked()).toBe(true);
    expect(document.body.style.overflow).toBe('scroll');

    // When
    popover.setOpen(false);
    await settle();

    // Then
    expect(scrollLocked()).toBe(false);
    expect(document.body.style.overflow).toBe('scroll');
  });

  it.each([
    ['in the order they opened', ['a', 'b']],
    ['nested, the last opened first', ['b', 'a']],
  ])(
    'As a user, with two dialogs open, the page stays locked until the last one closes, %s, then scrolls as before',
    async (_order, closing) => {
      // Given
      document.body.style.overflow = 'scroll';
      const dialogs = {
        a: renderPopover('dialog'),
        b: renderPopover('dialog'),
      };
      await openPopover(dialogs.a);
      await openPopover(dialogs.b);
      expect(scrollLocked()).toBe(true);

      // When
      dialogs[closing[0] as 'a' | 'b'].setOpen(false);
      await settle();

      // Then
      expect(scrollLocked()).toBe(true);

      // When
      dialogs[closing[1] as 'a' | 'b'].setOpen(false);
      await settle();

      // Then
      expect(scrollLocked()).toBe(false);
      expect(document.body.style.overflow).toBe('scroll');
    },
  );

  it('As a user, a dialog unmounted while open releases its scroll lock once, whatever closes after', async () => {
    // Given
    document.body.style.overflow = 'auto';
    const a = renderPopover('dialog');
    const b = renderPopover('dialog');
    await openPopover(a);
    await openPopover(b);

    // When
    a.unmount();
    await settle();

    // Then
    expect(scrollLocked()).toBe(true);

    // When
    b.setOpen(false);
    await settle();

    // Then
    expect(scrollLocked()).toBe(false);
    expect(document.body.style.overflow).toBe('auto');
  });

  it("As a user, closing the dialog keeps an overflow the page set while it was open, like the product frame's", async () => {
    // Given
    const popover = renderPopover('dialog');
    await openPopover(popover);

    // When: the product frame attaches while the dialog is open, and
    // bridge.ts hides the body's overflow for it.
    document.body.style.overflow = 'hidden';
    popover.setOpen(false);
    await settle();

    // Then
    expect(scrollLocked()).toBe(false);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('As a user, a click on the backdrop closes the dialog and focus goes back to the trigger', async () => {
    // Given
    const popover = renderPopover('dialog');
    await openPopover(popover);

    // When: the backdrop (here the harness's wrapper, which takes no focus)
    // is outside the dialog's surface.
    const { click, reached } = pointerClick(must(byId('surface').parentElement, "the surface's wrapper"));
    await settle();

    // Then: the click still reaches the backdrop, whose own handler may
    // close.
    expect(reached).toBe(true);
    expect(click.defaultPrevented).toBe(false);
    expect(popover.open()).toBe(false);
    expect(document.activeElement).toBe(byId('trigger'));
  });
});

describe('createPopover, mode chosen on each opening', () => {
  it('As a user, a mode given as a function is asked each time it opens, and that opening behaves in the mode it returned', async () => {
    // Given
    document.body.style.overflow = 'scroll';
    let mode: 'popover' | 'dialog' = 'popover';
    const popover = renderPopover(() => mode);

    // When
    await openPopover(popover);

    // Then: a non-modal popover, which leaves scroll alone.
    expect(document.activeElement).toBe(byId('first'));
    expect(scrollLocked()).toBe(false);

    // When: it closes and opens again, now asked for a dialog.
    popover.setOpen(false);
    await settle();
    mode = 'dialog';
    await openPopover(popover);

    // Then
    byId('last').focus();
    const tab = press('Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId('first'));
    expect(scrollLocked()).toBe(true);

    // When: the mode changes while it is open.
    mode = 'popover';

    // Then: the opening keeps the mode it opened in.
    expect(scrollLocked()).toBe(true);

    // When
    popover.setOpen(false);
    await settle();

    // Then
    expect(scrollLocked()).toBe(false);
  });
});

describe('createPopover, menu trigger clicks (as the islands wire them)', () => {
  /** A menu whose trigger's click toggles it and whose items count picks. */
  function renderWiredMenu(): Popover & { picks: ReturnType<typeof vi.fn> } {
    const popover = renderPopover('menu');
    byId('trigger').addEventListener('click', popover.toggle);
    const picks = vi.fn();
    for (const id of ['apple', 'banana', 'avocado', 'cherry']) {
      byId(id).addEventListener('click', picks);
    }
    return { ...popover, picks };
  }

  function keyUp(key: string): KeyboardEvent {
    const event = new KeyboardEvent('keyup', {
      key,
      bubbles: true,
      cancelable: true,
    });
    (document.activeElement ?? document.body).dispatchEvent(event);
    return event;
  }

  /** The click a browser fires for a key on a button: detail 0. */
  function keyClick(el: HTMLElement): MouseEvent {
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail: 0,
    });
    el.dispatchEvent(click);
    return click;
  }

  it.each([
    ['Space', 'trigger', ' '],
    ['Space', 'first item', ' '],
    ['Enter', 'trigger', 'Enter'],
    ['Enter', 'first item', 'Enter'],
  ])(
    'As a keyboard user, %s on the trigger opens the menu, and the click the browser still fires for the key on the %s neither closes it nor picks an item',
    async (_name, on, key) => {
      // Given
      const popover = renderWiredMenu();
      byId('trigger').focus();

      // When: keydown, then (Firefox, for Space) the keyup's click.
      press(key);
      await settle();
      expect(document.activeElement).toBe(byId('apple'));
      const up = keyUp(key);
      const click = keyClick(on === 'trigger' ? byId('trigger') : byId('apple'));
      await settle();

      // Then
      expect(up.defaultPrevented).toBe(true);
      expect(click.defaultPrevented).toBe(true);
      expect(popover.open()).toBe(true);
      expect(popover.picks).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(byId('apple'));
    },
  );

  it("As a keyboard user, the guard against the key's click ends with that key: a later keyboard pick still works", async () => {
    // Given
    const popover = renderWiredMenu();
    byId('trigger').focus();
    press(' ');
    await settle();
    keyUp(' ');
    await new Promise(resolve => setTimeout(resolve, 0));

    // When: Enter on the focused item, whose click the browser fires.
    press('Enter');
    keyClick(byId('apple'));
    await settle();

    // Then
    expect(popover.picks).toHaveBeenCalledTimes(1);
  });

  it('As a keyboard user, a click on the trigger with no pointer behind it (a forwarded keyboard choice) opens the menu as a keyboard opening, on the first item', async () => {
    // Given
    const popover = renderWiredMenu();

    // When
    byId('trigger').click();
    await settle();

    // Then
    expect(popover.open()).toBe(true);
    expect(document.activeElement).toBe(byId('apple'));
  });

  it('As a mouse user, a pointer click on the trigger opens the menu on the menu content', async () => {
    // Given
    const popover = renderWiredMenu();

    // When
    pointerClick(byId('trigger'));
    await settle();

    // Then
    expect(popover.open()).toBe(true);
    expect(document.activeElement).toBe(byId('surface'));
  });
});

describe('createPopover, touch outside (Radix usePointerDownOutside)', () => {
  function touchDown(el: HTMLElement): PointerEvent {
    const down = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'touch',
    });
    expect(down.pointerType).toBe('touch');
    el.dispatchEvent(down);
    return down;
  }

  function touchUp(el: HTMLElement): void {
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
  }

  function tap(el: HTMLElement): { click: MouseEvent; reached: boolean } {
    let reached = false;
    const onClick = (): void => {
      reached = true;
    };
    el.addEventListener('click', onClick);
    touchUp(el);
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    el.dispatchEvent(click);
    el.removeEventListener('click', onClick);
    return { click, reached };
  }

  it.each([
    { phone: true, reached: false, title: 'on a phone, it never reaches the page' },
    { phone: false, reached: true, title: 'on a wide screen, it reaches the page' },
  ])('As a touch user, a tap outside a sheet-capable popover: $title', async ({ phone, reached: expected }) => {
    // Given
    stubPhoneViewport(phone);
    const popover = renderPopover('popover', { sheet: true });
    await openPopover(popover);

    // When
    touchDown(byId('outside'));
    const { reached } = tap(byId('outside'));
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(reached).toBe(expected);
  });

  it.each<PopoverMode>(['popover', 'menu', 'dialog'])(
    'As a phone user, a touch outside the %s closes it only once it is a tap',
    async mode => {
      // Given
      const popover = renderPopover(mode);
      await openPopover(popover);

      // When
      touchDown(byId('outside'));
      await settle();

      // Then
      expect(popover.open()).toBe(true);

      // When
      const { reached } = tap(byId('outside'));
      await settle();

      // Then: a menu swallows the click, the others let it through.
      expect(popover.open()).toBe(false);
      expect(reached).toBe(mode !== 'menu');
    },
  );

  it.each([
    ['pointercancel', () => document.dispatchEvent(new Event('pointercancel'))],
    ['scroll', () => document.dispatchEvent(new Event('scroll'))],
  ])(
    'As a phone user, a touch outside that becomes a %s (I started scrolling) leaves the menu open, and swallows nothing after',
    async (_name, cancel) => {
      // Given
      const popover = renderPopover('menu');
      await openPopover(popover);

      // When
      touchDown(byId('outside'));
      cancel();
      await settle();
      const { reached } = tap(byId('outside'));
      await settle();

      // Then
      expect(popover.open()).toBe(true);
      expect(reached).toBe(true);
    },
  );

  it.each<PopoverMode>(['popover', 'menu'])(
    'As an iPhone user, a tap outside the %s closes it even when no click follows',
    async mode => {
      // Given: iOS fires no click on a non-interactive element when the only
      // listeners are on the document.
      const popover = renderPopover(mode);
      await openPopover(popover);

      // When
      touchDown(byId('outside'));
      touchUp(byId('outside'));
      await settle();

      // Then
      expect(popover.open()).toBe(false);
    },
  );

  it('As an iPhone user, after a tap closed the menu with no click, my next tap is not swallowed', async () => {
    // Given
    const popover = renderPopover('menu');
    await openPopover(popover);
    touchDown(byId('outside'));
    touchUp(byId('outside'));
    await settle();

    // When: the next press, on something with a click listener.
    touchDown(byId('outside'));
    const { reached } = tap(byId('outside'));

    // Then
    expect(reached).toBe(true);
  });

  it('As an assistive-technology user, a click that arrives after a tap closed the menu and a moment passed is not swallowed', async () => {
    // Given: an outside tap closed the menu and no click followed it.
    const popover = renderPopover('menu');
    await openPopover(popover);
    vi.useFakeTimers();
    try {
      touchDown(byId('outside'));
      touchUp(byId('outside'));

      // When: a moment passes, then a click lands on the page.
      vi.advanceTimersByTime(1000);
      const { reached } = tap(byId('outside'));

      // Then
      expect(reached).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('As a phone user, a touch outside the popover that becomes a scroll leaves it open', async () => {
    // Given
    const popover = renderPopover('popover');
    await openPopover(popover);

    // When
    touchDown(byId('outside'));
    byId('outside').dispatchEvent(
      new PointerEvent('pointercancel', {
        bubbles: true,
        pointerType: 'touch',
      }),
    );
    await settle();
    tap(byId('outside'));
    await settle();

    // Then
    expect(popover.open()).toBe(true);
  });
});
