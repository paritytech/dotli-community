// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, lazy, untrack, useContext, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import {
  createAnchored,
  createSurfaceLoad,
  createTriggerWiring,
  SurfaceSlot,
  type Anchored,
  type SurfaceChunk,
} from './anchored.js';
import type { CloseReason } from './close-reason.js';
import type { Placement } from './FloatingLayer.js';
import s from './DropdownMenu.module.css';

/** Off the first visit's path. */
const Surface = lazy(() => import('./DropdownMenuSurface.js'), { export: 'DropdownMenuSurface' });

let surfaceLoaded = false;

/** Loads the surface ahead of the idle preload, for tests that read a surface in the tick that opens it. */
export function preloadDropdownMenuSurface(): Promise<unknown> {
  const loading = Surface.preload();
  loading.then(
    () => {
      surfaceLoaded = true;
    },
    () => undefined,
  );
  return loading;
}

const chunk: SurfaceChunk = { load: preloadDropdownMenuSurface, loaded: () => surfaceLoaded };

export type MenuState = Anchored & {
  /** The opening came from a key, so it lands on the first item. */
  keyboard: { value: boolean };
};

const MenuContext = createContext<MenuState | null>(null);

/** How a choice made in the sheet runs. The surface provides the hand-off so its chunk carries it. */
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

/** For content that closes the menu itself (More, when its last row goes). */
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
 * Unlike Popover's, not `programmatic`: a choice hands focus back itself before the item acts, since a microtask
 * here would take focus from the surface the item opens.
 */
const RETURN_FOCUS_ON: ReadonlySet<CloseReason> = new Set(['escape', 'sheet', 'trigger']);

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
  const anchored = createAnchored(props, RETURN_FOCUS_ON);
  const state: MenuState & { setTrigger: (el: HTMLElement | undefined) => void } = Object.assign(anchored, {
    keyboard: { value: false },
  });
  createTriggerWiring(state, () => props.trigger, 'menu', {
    opening: ev => {
      state.keyboard.value = ev.detail === 0;
    },
    onKeyDown: ev => {
      if (ev.key === 'ArrowDown' && !untrack(state.open)) {
        ev.preventDefault();
        state.keyboard.value = true;
        state.setOpen(true);
      }
    },
  });
  createSurfaceLoad(state, chunk, () => undefined);
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
 * Focus goes back before `onSelect` runs, so a surface it opens takes focus on its own terms.
 * In a sheet it runs as a hand-off, so a sheet it opens takes the menu's place in the same frame. On the first
 * visit's path, so the menu's keys live in the surface.
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
