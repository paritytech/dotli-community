// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, lazy, untrack, useContext, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createAnchored, createSurfacePreload, SurfaceSlot, createTriggerWiring, type Anchored } from './anchored.js';
import type { CloseReason } from './close-reason.js';
import type { Placement } from './FloatingLayer.js';
import s from './DropdownMenu.module.css';

/** The frame, the sheet and the menu's keys: a chunk of their own, off the first visit's path. */
const Surface = lazy(() => import('./DropdownMenuSurface.js'), { export: 'DropdownMenuSurface' });

/** Load the surface's chunk now, ahead of the idle preload every DropdownMenu makes. */
export function preloadDropdownMenuSurface(): Promise<unknown> {
  return Surface.preload();
}

export type MenuState = Anchored & {
  /** The opening came from a key: it lands on the first item. */
  keyboard: { value: boolean };
};

const MenuContext = createContext<MenuState | null>(null);

/**
 * How a choice made in the sheet runs. The surface provides the sheet's
 * hand-off, so its chunk carries it; the items render only inside it.
 */
export const SheetChoice = createContext<(select: () => void) => void>(select => {
  select();
});

function useMenuState(): MenuState {
  const state = useContext(MenuContext);
  if (state === null) {
    throw new Error('DropdownMenu parts outside a DropdownMenu');
  }
  return state;
}

/** The menu's open state, for content that closes it itself (More, when its last row goes). */
export function useDropdownMenu(): { open: Accessor<boolean>; setOpen: (open: boolean) => void } {
  const state = useMenuState();
  return {
    open: state.open,
    setOpen: next => {
      state.setOpen(next);
    },
  };
}

/**
 * Escape, the sheet's own close and the button hand focus back. Not a
 * programmatic close, unlike Popover's: a choice hands focus back itself,
 * before the item acts, since a microtask here would take focus back from
 * the surface the item opens. A press outside, a blur or focus moving away
 * keeps it where the user put it.
 */
const RETURN_FOCUS_ON: ReadonlySet<CloseReason> = new Set(['escape', 'sheet', 'trigger']);

/**
 * A menu of actions opened from a button: anchored glass on wide screens
 * (a FloatingLayer, `role="menu"`, named by the title), a bottom sheet
 * titled `title` when it opens on a phone's, whose body is the `role="menu"`
 * element. `class` goes on the anchored surface, and in a sheet on the rows'
 * wrapper. A key opening focuses the first item, a pointer opening the menu.
 * Choosing an item closes the menu and hands focus back before the item
 * acts, so a surface the item opens takes focus as its own kind says, and
 * no layer opens inside the menu's.
 *
 * On the trigger, Enter and Space open the menu through the click they make
 * (`detail` 0), ArrowDown on its own; each lands on the first item. The
 * surface is a lazy chunk, preloaded when the browser is idle.
 */
function DropdownMenuRoot(props: {
  id: string;
  title: string;
  /** The button that opens it, wired while given (see createTriggerWiring). */
  trigger: HTMLElement | undefined;
  class?: string | undefined;
  placement?: Placement | undefined;
  children: JSX.Element;
}): JSX.Element {
  const anchored = createAnchored(props, RETURN_FOCUS_ON);
  const state: MenuState & { setTrigger: (el: HTMLElement | undefined) => void } = Object.assign(anchored, {
    keyboard: { value: false },
  });
  createTriggerWiring(state, () => props.trigger, 'menu', {
    opening: ev => {
      state.keyboard.value = ev.detail === 0;
    },
    onKeyDown: (ev, el) => {
      if (ev.key === 'ArrowDown' && !untrack(state.open) && el.hasAttribute('popovertarget')) {
        ev.preventDefault();
        state.keyboard.value = true;
        state.setOpen(true);
      }
    },
  });
  createSurfacePreload(state, Surface.preload, () => undefined);
  return (
    <MenuContext value={state}>
      <SurfaceSlot state={state}>
        <Surface state={state} class={props.class} placement={props.placement}>
          {props.children}
        </Surface>
      </SurfaceSlot>
    </MenuContext>
  );
}

/**
 * One action. Choosing it closes the menu and hands focus back, then runs
 * `onSelect` with the click (`detail` 0 for a key's). In a sheet it runs
 * as a hand-off: a sheet it opens takes the menu's place in the same frame.
 * On the first visit's path, as consumers render it: markup and the choice
 * only, the menu's keys are the surface's.
 */
function Item(props: {
  onSelect: (ev: MouseEvent) => void;
  class?: string | undefined;
  testId?: string | undefined;
  'data-item'?: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  const state = useMenuState();
  const inSheet = useContext(SheetChoice);
  const choose = (ev: MouseEvent): void => {
    const select = (): void => {
      state.setOpen(false);
      state.focusBack();
      props.onSelect(ev);
    };
    if (untrack(state.sheet)) {
      inSheet(select);
    } else {
      select();
    }
  };
  return (
    <button
      type="button"
      class={[s['row'], props.class]}
      role="menuitem"
      tabindex="-1"
      data-item={props['data-item']}
      data-testid={props.testId}
      onClick={choose}
    >
      {props.children}
    </button>
  );
}

export const DropdownMenu = Object.assign(DropdownMenuRoot, { Item });
