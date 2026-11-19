// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createContext,
  createMemo,
  createSignal,
  createUniqueId,
  onSettled,
  Show,
  untrack,
  useContext,
  type Accessor,
  type Component,
} from 'solid-js';
import type { JSX } from '@solidjs/web';
import { DrawIcon } from '../icons/DrawIcon.js';
import type { IconProps } from '../icons/iconProps.js';
import { Listbox } from '../primitives/Listbox.js';
import { createAnchored, type Anchored } from './createAnchored.js';
import { createTriggerWiring } from './createTriggerWiring.js';
import { SurfaceSlot } from './SurfaceSlot.js';
import type { CloseReason } from './closeReason.js';
import { DropdownMenuSurface, stepIndex } from './DropdownMenuSurface.js';
import { createSheetPreload } from './SheetContent.js';
import { SheetChoice } from './sheetChoice.js';
import s from './DropdownMenu.module.css';

export type MenuState = Anchored & {
  /** Whether the last opening came from a key, so it lands on the first item. */
  byKey: () => boolean;
  /** Records whether the next opening comes from a key. */
  setByKey: (byKey: boolean) => void;
  /** The option the trigger's keys point at on a wide screen, by its id, null while none is. */
  active: Accessor<string | null>;
  /**
   * Tells the menu that the option `id` shows, so an opening by key points at the first option once its options show.
   * The returned removal, run as the option leaves, clears the cursor only while it points at that option. Idempotent.
   */
  showOption: (id: string) => () => void;
};

/**
 * Where the trigger's keys point in the wide list. `first` is an opening by key whose options have not rendered yet.
 */
type Cursor = { kind: 'none' } | { kind: 'first' } | { kind: 'option'; id: string };

const NO_CURSOR: Cursor = { kind: 'none' };

const OPTION = '[role="option"]';

const MenuContext = createContext<MenuState | null>(null);

/**
 * Unlike Popover's, not `programmatic`: a choice hands focus back itself before the item acts, since a microtask
 * here would take focus from the surface the item opens.
 */
const RETURN_FOCUS_ON: ReadonlySet<CloseReason> = new Set(['escape', 'sheet', 'trigger']);

export const DropdownMenu = Object.assign(DropdownMenuRoot, { Item });

/**
 * A menu of actions opened from a button. On a wide screen it is a list hung from the button's end, which the button
 * drives as a combobox while keeping focus: the arrows, Home and End move the active option and Enter picks it. On a
 * phone it is a bottom sheet of menu rows that take focus, and the button is a menu button. The button's ARIA follows
 * the viewport, and a build-time render is wide. `class` goes on the rows' wrapper in a sheet. Enter and Space open it
 * through the click they make (`detail` 0).
 */
function DropdownMenuRoot(props: {
  id: string;
  title: string;
  /** Wired while given. */
  trigger: HTMLElement | undefined;
  class?: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  const anchored = createAnchored({ props, returnFocusOn: RETURN_FOCUS_ON });
  let byKey = false;
  const [cursor, setCursor] = createSignal<Cursor>(NO_CURSOR, { ownedWrite: true });
  const active = createMemo(() => {
    const at = cursor();
    return at.kind === 'option' ? at.id : null;
  });
  const state = Object.assign(anchored, { byKey: () => byKey, setByKey, active, showOption });

  createTriggerWiring({
    state,
    trigger: () => props.trigger,
    // The viewport's form, so the trigger's ARIA and keys are those of the form an opening shows.
    popup: () =>
      state.phone()
        ? { haspopup: 'menu' }
        : { haspopup: 'listbox', combobox: { activeDescendant: state.open() ? active() : null } },
    opening(event) {
      setByKey(event.detail === 0);
    },
    onKeyDown(event) {
      if (untrack(state.phone)) {
        handleSheetKey(event);
      } else {
        handleListKey(event);
      }
    },
  });
  createSheetPreload();

  function setByKey(next: boolean): void {
    byKey = next;
    // Every opening mounts its options afresh, even while the last one's still play out, so the opening's own options
    // resolve `first` as they show.
    setCursor(next ? { kind: 'first' } : NO_CURSOR);
  }

  function showOption(id: string): () => void {
    setCursor(at => {
      const first = at.kind === 'first' ? listOptions()[0] : undefined;
      return first === undefined ? at : { kind: 'option', id: first.id };
    });
    return () => {
      setCursor(at => (at.kind === 'option' && at.id === id ? NO_CURSOR : at));
    };
  }

  /** The list's options as shown now, in document order. */
  function listOptions(): HTMLElement[] {
    return Array.from(document.getElementById(state.id)?.querySelectorAll<HTMLElement>(OPTION) ?? []);
  }

  function openByKey(event: KeyboardEvent): void {
    event.preventDefault();
    setByKey(true);
    state.setOpen(true);
  }

  function handleSheetKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' && !untrack(state.open)) {
      openByKey(event);
    }
  }

  function handleListKey(event: KeyboardEvent): void {
    if (!untrack(state.open)) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        openByKey(event);
      }
      return;
    }
    const options = listOptions();
    const id = untrack(active);
    const index = options.findIndex(option => option.id === id);
    if (event.key === 'Enter') {
      const option = options[index];
      if (option !== undefined) {
        // Also keeps the button's own click from closing the list.
        event.preventDefault();
        // A click from script has `detail` 0, as a choice by key does.
        option.click();
      }
      return;
    }
    const step = stepIndex(event.key, index, options.length);
    const next = step === null ? undefined : options[step];
    if (next !== undefined) {
      event.preventDefault();
      setCursor({ kind: 'option', id: next.id });
    }
  }

  return (
    <MenuContext value={state}>
      <SurfaceSlot state={state}>
        <DropdownMenuSurface
          state={state}
          anchor={props.trigger}
          class={props.class}
          onClose={() => {
            state.setOpen(false);
          }}
        >
          {props.children}
        </DropdownMenuSurface>
      </SurfaceSlot>
    </MenuContext>
  );
}

type ItemProps = {
  onSelect: (event: MouseEvent) => void;
  icon?: Component<IconProps> | undefined;
  end?: JSX.Element | undefined;
  /** On the sheet's row. */
  class?: string | undefined;
  testId?: string | undefined;
  'data-item'?: string | undefined;
  children: JSX.Element;
};

/**
 * An option of the list on a wide screen, or a row of the sheet on a phone, led by `icon` and ended by `end`. A choice
 * closes the menu and hands focus back to the trigger before `onSelect` runs with the click, so a surface it opens
 * takes focus on its own terms. In a sheet it runs as a hand-off, so a sheet it opens takes the menu's place in the same
 * frame.
 */
function Item(props: ItemProps): JSX.Element {
  const state = useMenuState();
  const inSheet = useContext(SheetChoice);
  // Each form renders its own items, so an item stays in the form it was made for.
  const sheet = untrack(state.sheet);
  function choose(event: MouseEvent): void {
    function select(): void {
      state.setOpen(false);
      state.focusBack();
      props.onSelect(event);
    }
    if (sheet) {
      inSheet(select);
    } else {
      select();
    }
  }
  return (
    <Show when={sheet} fallback={<ListOption item={props} onPick={choose} />}>
      <button
        type="button"
        class={[s['row'], props.class]}
        role="menuitem"
        tabindex="-1"
        data-item={props['data-item']}
        data-testid={props.testId}
        onClick={choose}
      >
        <Show when={props.icon}>
          {icon => (
            <span class={s['icon']} aria-hidden="true">
              <DrawIcon icon={icon()} />
            </span>
          )}
        </Show>
        <span class={s['label']}>{props.children}</span>
        {props.end}
      </button>
    </Show>
  );
}

/** An item as an option of the wide list. */
function ListOption(props: { item: ItemProps; onPick: (event: MouseEvent) => void }): JSX.Element {
  const state = useMenuState();
  const id = createUniqueId();
  onSettled(() => state.showOption(id));
  return (
    <Listbox.Option
      id={id}
      active={state.active() === id}
      icon={props.item.icon}
      end={props.item.end}
      data-item={props.item['data-item']}
      testId={props.item.testId}
      onPick={props.onPick}
    >
      {props.item.children}
    </Listbox.Option>
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
      state.setByKey(false);
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
