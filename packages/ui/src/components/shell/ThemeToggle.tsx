// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Portal, type JSX } from '@solidjs/web';
import { themeStore, type ThemePref } from '../../state/theme.js';
import { selectThemePref } from '../../theme-controller.js';
import { IconButton } from '../primitives/IconButton.js';
import { Menu, MenuRow } from '../primitives/Menu.js';
import { useStore } from '../use-store.js';
import { createPopover } from './create-popover.js';
import { TOPBAR_PRIORITY } from './topbar/fit.js';
import { TopbarItem } from './topbar/TopbarItem.js';
import s from './ThemeToggle.module.css';

const THEME_LABEL: Record<ThemePref, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

interface GlyphProps {
  class?: string | undefined;
  testId?: string | undefined;
}

function SunGlyph(props: GlyphProps): JSX.Element {
  return (
    <svg
      class={props.class}
      data-testid={props.testId}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonGlyph(props: GlyphProps): JSX.Element {
  return (
    <svg
      class={props.class}
      data-testid={props.testId}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function MonitorGlyph(props: GlyphProps): JSX.Element {
  return (
    <svg
      class={props.class}
      data-testid={props.testId}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="20" height="14" rx="3" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

/**
 * The sun and moon, of which CSS shows the theme in effect,
 * `<html data-theme>`, so System shows what it resolved to: on the button or
 * a More menu row.
 */
function ThemeIcons(): JSX.Element {
  return (
    <>
      <SunGlyph class={s['sun']} testId="theme-icon-sun" />
      <MoonGlyph class={s['moon']} testId="theme-icon-moon" />
    </>
  );
}

/** One tile of the menu: its glyph over its label. */
function Tile(props: { pref: ThemePref; checked: boolean; children: JSX.Element }): JSX.Element {
  return (
    <MenuRow class={s['tile']} role="menuitemradio" checked={props.checked} data-theme-option={props.pref}>
      {props.children}
      <span>{THEME_LABEL[props.pref]}</span>
    </MenuRow>
  );
}

/**
 * The shell's appearance button (`#theme-toggle`) and its menu
 * (`#theme-popover`, rendered into the body), an item of the topbar's action
 * group island (see src/islands/): rendered with the host page from the theme
 * store's default ("Appearance: System"), then hydrated, which brings the
 * stored preference. The landing page (components/landing/) renders it too,
 * in its corner.
 *
 * The menu is the board's Appearance popover: a title over three tiles
 * (Light, Dark, System). On a phone it opens as a bottom sheet whose head
 * carries the title. It is a modal menu, like Radix DropdownMenu with a
 * RadioGroup (createPopover's `menu` mode, which owns its keys and focus): a
 * keyboard opening focuses the first tile and a pointer opening the menu
 * itself. The arrows (Left and Right along the row, Up and Down too, all
 * wrapping), Home, End and typeahead move between the tiles
 * (`menuitemradio`, `aria-checked` on the current one). Escape closes and
 * hands focus back to the button, Tab is prevented (in a sheet, Tab reaches
 * the head's close button), and a press outside
 * closes it without reaching what is underneath. Picking a tile applies it
 * through theme-controller.ts, closes the menu and focuses the button (or
 * the More button, while the topbar has collapsed the appearance button).
 * The title is hidden from assistive technology, as the menu's own name
 * already says it.
 *
 * The button's icon comes from CSS on `<html data-theme>`, which the inline
 * bootstrap script and theme-controller.ts own, never this component: the
 * script sets it before the island hydrates, so the build-time button already
 * shows the theme in effect, and the controller follows the OS while the
 * choice is System.
 * The More menu's Appearance row opens this menu with the row click: a
 * keyboard choice (`detail` 0) opens it as a keyboard opening, on the first
 * tile.
 *
 * `idPrefix` sets another instance's ids apart (the landing page's, whose
 * page also holds the topbar's build-time markup).
 */
export function ThemeToggle(props: { idPrefix?: string }): JSX.Element {
  const id = (name: string): string => `${props.idPrefix ?? ''}${name}`;
  let button: HTMLButtonElement | undefined;
  let popover: HTMLDivElement | undefined;
  const theme = useStore(themeStore);
  const pref = (): ThemePref => theme().pref;
  const title = (): string => `Appearance: ${THEME_LABEL[pref()]}`;

  const menu = createPopover({
    mode: 'menu',
    sheet: true,
    trigger: () => button,
    surface: () => popover,
  });

  const onClick = (e: MouseEvent): void => {
    const option = (e.target as HTMLElement).closest<HTMLElement>('[data-theme-option]');
    const next = option?.dataset['themeOption'];
    if (next === 'light' || next === 'dark' || next === 'system') {
      selectThemePref(next);
      menu.onItemChosen();
    }
  };

  return (
    <>
      <TopbarItem
        name="theme"
        label="Appearance"
        icon={ThemeIcons}
        priority={TOPBAR_PRIORITY.theme}
        activate={menu.toggle}
      >
        <IconButton
          ref={el => {
            button = el;
          }}
          onClick={menu.toggle}
          id={id('theme-toggle')}
          title={title()}
          aria-label={title()}
          aria-haspopup="menu"
          aria-expanded={menu.open() ? 'true' : 'false'}
          aria-controls={id('theme-popover')}
        >
          <ThemeIcons />
        </IconButton>
      </TopbarItem>
      <Portal>
        <Menu
          ref={el => {
            popover = el;
          }}
          onClick={onClick}
          class={s['menu']}
          id={id('theme-popover')}
          popover={menu}
          label="Appearance"
          orientation="horizontal"
        >
          <div class={s['head']} aria-hidden="true">
            Appearance
          </div>
          <div class={s['tiles']} role="group">
            <Tile pref="light" checked={pref() === 'light'}>
              <SunGlyph />
            </Tile>
            <Tile pref="dark" checked={pref() === 'dark'}>
              <MoonGlyph />
            </Tile>
            <Tile pref="system" checked={pref() === 'system'}>
              <MonitorGlyph />
            </Tile>
          </div>
        </Menu>
      </Portal>
    </>
  );
}
