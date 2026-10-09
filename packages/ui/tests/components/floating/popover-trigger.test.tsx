// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { DropdownMenu } from '../../../src/components/floating/DropdownMenu.js';
import { Popover } from '../../../src/components/floating/Popover.js';
import { mouseClick, renderComponent, settle } from '../../helpers/solid.js';
import { byId } from '../../support.js';
import { useFloatingSurfaces } from '../../helpers/floating.js';

type Held = 'a' | 'b' | undefined;

/** Buttons A and B, and a popover triggered by whichever one `held` names. */
function renderHarness(initial: Held, onOpenChange: (open: boolean) => void = () => undefined): (held: Held) => void {
  const [held, setHeld] = createSignal<Held>(initial);
  renderComponent(() => {
    const [a, setA] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
    const [b, setB] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
    const trigger = (): HTMLButtonElement | undefined => {
      const which = held();
      return which === 'a' ? a() : which === 'b' ? b() : undefined;
    };
    return (
      <>
        <button ref={setA} id="a" type="button">
          A
        </button>
        <button ref={setB} id="b" type="button">
          B
        </button>
        <Popover id="story" title="Story" trigger={trigger()} onOpenChange={onOpenChange}>
          <button type="button" id="inside">
            Inside
          </button>
        </Popover>
      </>
    );
  });
  return next => {
    setHeld(next);
  };
}

function triggerAttributes(el: HTMLElement): Record<string, string | null> {
  return {
    popovertarget: el.getAttribute('popovertarget'),
    'aria-haspopup': el.getAttribute('aria-haspopup'),
    'aria-expanded': el.getAttribute('aria-expanded'),
    'aria-controls': el.getAttribute('aria-controls'),
    'anchor-name': el.style.getPropertyValue('anchor-name'),
  };
}

function isOpen(): boolean {
  return document.getElementById('story')?.hasAttribute('data-open') === true;
}

useFloatingSurfaces();

describe('A Popover given its trigger', () => {
  it('As a screen-reader user, the button it holds announces the dialog, whose opening flips aria-expanded', async () => {
    // Given
    renderHarness('a');
    await settle();

    // Then
    expect(triggerAttributes(byId('a'))).toEqual({
      popovertarget: 'story',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      'aria-controls': 'story',
      'anchor-name': '--anchor-story',
    });
    expect(triggerAttributes(byId('b'))).toEqual({
      popovertarget: null,
      'aria-haspopup': null,
      'aria-expanded': null,
      'aria-controls': null,
      'anchor-name': '',
    });

    // When
    mouseClick(byId('a'));
    await settle();

    // Then
    expect(isOpen()).toBe(true);
    expect(byId('a').getAttribute('aria-expanded')).toBe('true');

    // When
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(byId('a').getAttribute('aria-expanded')).toBe('false');
  });

  it('As a dotli user, a button the popover lets go loses the invoker and the anchor, keeps its ARIA, and opens nothing', async () => {
    // Given
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const setHeld = renderHarness('a', onOpenChange);
    await settle();

    // When: the popover takes B instead.
    setHeld('b');
    await settle();

    // Then
    expect(triggerAttributes(byId('a'))).toEqual({
      popovertarget: null,
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      'aria-controls': 'story',
      'anchor-name': '',
    });
    expect(triggerAttributes(byId('b'))).toEqual({
      popovertarget: 'story',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      'aria-controls': 'story',
      'anchor-name': '--anchor-story',
    });

    // When
    mouseClick(byId('a'));
    await settle();

    // Then
    expect(onOpenChange).not.toHaveBeenCalled();

    // When: it holds none.
    setHeld(undefined);
    await settle();
    mouseClick(byId('b'));
    await settle();

    // Then
    expect(byId('b').hasAttribute('popovertarget')).toBe(false);
    expect(byId('b').style.getPropertyValue('anchor-name')).toBe('');
    expect(byId('b').getAttribute('aria-controls')).toBe('story');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('As a dotli user, a button handed back and forth is wired once: one click opens once', async () => {
    // Given
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const setHeld = renderHarness('a', onOpenChange);
    await settle();

    // When: A, then B, then A again.
    setHeld('b');
    await settle();
    setHeld('a');
    await settle();
    mouseClick(byId('a'));
    await settle();

    // Then
    expect(onOpenChange.mock.calls).toEqual([[true]]);
    expect(isOpen()).toBe(true);
  });

  it('As a signed-in user whose session drops while the popover is open, it closes and focus goes back to the button it let go', async () => {
    // Given: open, with focus inside.
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const setHeld = renderHarness('a', onOpenChange);
    await settle();
    mouseClick(byId('a'));
    await settle();
    byId('inside').focus();

    // When: the popover lets its button go.
    setHeld(undefined);
    await settle();
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
    expect(document.activeElement).toBe(byId('a'));
  });

  it('As a dotli user, a button let go while the popover is open and focus is not inside closes it and leaves focus alone', async () => {
    // Given: open, with focus dropped to the body (as Safari leaves it after a press).
    const setHeld = renderHarness('a');
    await settle();
    mouseClick(byId('a'));
    await settle();
    (document.activeElement as HTMLElement | null)?.blur();

    // When
    setHeld(undefined);
    await settle();
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('As a screen-reader user, a DropdownMenu trigger announces a menu', async () => {
    // Given
    renderComponent(() => {
      const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
      return (
        <>
          <button ref={setButton} id="more" type="button">
            More
          </button>
          <DropdownMenu id="menu" title="More" trigger={button()}>
            <DropdownMenu.Item onSelect={() => undefined}>Row</DropdownMenu.Item>
          </DropdownMenu>
        </>
      );
    });
    await settle();

    // Then
    expect(triggerAttributes(byId('more'))).toEqual({
      popovertarget: 'menu',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'aria-controls': 'menu',
      'anchor-name': '--anchor-menu',
    });
  });
});
