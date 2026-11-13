// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, untrack, useContext, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createSheetPreload } from './AnchoredContent.js';
import { createAnchored, type Anchored } from './createAnchored.js';
import { createTriggerWiring } from './createTriggerWiring.js';
import { SurfaceSlot } from './SurfaceSlot.js';
import type { CloseReason } from './closeReason.js';
import { DropdownMenuSurface } from './DropdownMenuSurface.js';
import { SheetChoice } from './sheetChoice.js';
import type { Placement } from './FloatingLayer.js';
import s from './DropdownMenu.module.css';

export type MenuState = Anchored & {
  /** The opening came from a key, so it lands on the first item. */
  keyboard: { value: boolean };
};

const MenuContext = createContext<MenuState | null>(null);

/**
 * Unlike Popover's, not `programmatic`: a choice hands focus back itself before the item acts, since a microtask
 * here would take focus from the surface the item opens.
 */
const RETURN_FOCUS_ON: ReadonlySet<CloseReason> = new Set(['escape', 'sheet', 'trigger']);

export const DropdownMenu = Object.assign(DropdownMenuRoot, { Item });

/**
 * A menu of actions opened from a button: anchored on wide screens, a bottom sheet on a phone.
 * `class` goes on the anchored surface, or on the rows' wrapper in a sheet. Enter and Space open it through the
 * click they make (`detail` 0).
 */
function DropdownMenuRoot(props: {
  id: string;
  title: string;
  /** Wired while given. */
  trigger: HTMLElement | undefined;
  class?: string | undefined;
  placement?: Placement | undefined;
  children: JSX.Element;
}): JSX.Element {
  const anchored = createAnchored({ props, returnFocusOn: RETURN_FOCUS_ON });
  const state = Object.assign(anchored, {
    keyboard: { value: false },
  });
  createTriggerWiring({
    state,
    trigger: () => props.trigger,
    haspopup: 'menu',
    opening(event) {
      state.keyboard.value = event.detail === 0;
    },
    onKeyDown(event) {
      if (event.key === 'ArrowDown' && !untrack(state.open)) {
        event.preventDefault();
        state.keyboard.value = true;
        state.setOpen(true);
      }
    },
  });
  createSheetPreload();
  return (
    <MenuContext value={state}>
      <SurfaceSlot state={state}>
        <DropdownMenuSurface state={state} class={props.class} placement={props.placement}>
          {props.children}
        </DropdownMenuSurface>
      </SurfaceSlot>
    </MenuContext>
  );
}

/**
 * Focus goes back before `onSelect` runs, so a surface it opens takes focus on its own terms.
 * In a sheet it runs as a hand-off, so a sheet it opens takes the menu's place in the same frame.
 */
function Item(props: {
  onSelect: (event: MouseEvent) => void;
  class?: string | undefined;
  testId?: string | undefined;
  'data-item'?: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  const state = useMenuState();
  const inSheet = useContext(SheetChoice);
  function choose(event: MouseEvent): void {
    function select(): void {
      state.setOpen(false);
      state.focusBack();
      props.onSelect(event);
    }
    if (untrack(state.sheet)) {
      inSheet(select);
    } else {
      select();
    }
  }
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

/**
 * For content that closes the menu itself (More, when its last row goes). Throws outside a DropdownMenu, and its
 * `setOpen` throws only what the menu's `onOpenChange` throws.
 */
export function useDropdownMenu(): { open: Accessor<boolean>; setOpen: (open: boolean) => void } {
  const state = useMenuState();
  return {
    open: state.open,
    setOpen(next) {
      state.setOpen(next);
    },
  };
}

function useMenuState(): MenuState {
  const state = useContext(MenuContext);
  if (state === null) {
    throw new Error('DropdownMenu parts outside a DropdownMenu');
  }
  return state;
}
