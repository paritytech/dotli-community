// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show, useContext } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { themeStore, type ThemePref } from '../../state/theme.js';
import { selectThemePref } from '../../theme-controller.js';
import { InSheet } from '../floating/in-sheet.js';
import { Popover } from '../floating/Popover.js';
import { IconButton } from '../primitives/IconButton.js';
import { useStore } from '../use-store.js';
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

const PREFS: readonly ThemePref[] = ['light', 'dark', 'system'];

/** One radio of the group: its glyph over its label. */
function Tile(props: { pref: ThemePref; checked: boolean; children: JSX.Element }): JSX.Element {
  return (
    <button
      type="button"
      class={s['tile']}
      role="radio"
      aria-checked={props.checked ? 'true' : 'false'}
      tabindex={props.checked ? '0' : '-1'}
      data-pref={props.pref}
      data-testid={`theme-option-${props.pref}`}
      onClick={() => {
        selectThemePref(props.pref);
      }}
    >
      {props.children}
      <span>{THEME_LABEL[props.pref]}</span>
    </button>
  );
}

/** A radio group's arrows: the next or previous choice, wrapping, chosen and focused. */
function onTilesKeyDown(ev: KeyboardEvent, current: ThemePref): void {
  const step =
    ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
  if (step === 0) {
    return;
  }
  ev.preventDefault();
  const next = PREFS.at((PREFS.indexOf(current) + step + PREFS.length) % PREFS.length) ?? current;
  selectThemePref(next);
  (ev.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-pref="${next}"]`)?.focus();
}

/**
 * The shell's appearance button (`#theme-toggle`) and its popover
 * (`#theme-popover`, rendered into the body), an item of the topbar's action
 * group island (see src/islands/): rendered with the host page from the theme
 * store's default ("Appearance: System"), then hydrated, which brings the
 * stored preference.
 *
 * The popover is the board's Appearance popover: a title over three tiles
 * (Light, Dark, System), a radio group (`role="radio"`, `aria-checked` on
 * the current one, which alone is in the Tab order). Opening focuses the
 * current tile. The arrows (Left and Right along the row, Up and Down too,
 * all wrapping) choose the next or previous tile and focus it, as a radio
 * group does. Picking a tile applies it through theme-controller.ts and
 * leaves the popover open, so the user sees the page in the new theme and
 * can pick again. On a phone it opens as a bottom sheet whose head carries
 * the title. The title is hidden from assistive technology, as the dialog's
 * own name already says it. Closing is Popover's: a press outside, Escape,
 * the button again.
 *
 * The button's icon comes from CSS on `<html data-theme>`, which the inline
 * bootstrap script and theme-controller.ts own, never this component: the
 * script sets it before the island hydrates, so the build-time button already
 * shows the theme in effect, and the controller follows the OS while the
 * choice is System.
 * The More menu's Appearance row opens this popover with the row click.
 */
export function ThemeToggle(): JSX.Element {
  const theme = useStore(themeStore);
  const pref = (): ThemePref => theme().pref;
  const title = (): string => `Appearance: ${THEME_LABEL[pref()]}`;
  return (
    <Popover id="theme-popover" title="Appearance">
      <Popover.Trigger>
        {(t, activate) => (
          <TopbarItem
            name="theme"
            label="Appearance"
            icon={ThemeIcons}
            priority={TOPBAR_PRIORITY.theme}
            activate={activate}
          >
            <IconButton {...t} id="theme-toggle" title={title()} aria-label={title()}>
              <ThemeIcons />
            </IconButton>
          </TopbarItem>
        )}
      </Popover.Trigger>
      <Popover.Content class={s['popover']}>
        <AppearanceBody pref={pref()} />
      </Popover.Content>
    </Popover>
  );
}

function AppearanceBody(props: { pref: ThemePref }): JSX.Element {
  const inSheet = useContext(InSheet);
  return (
    <>
      <Show when={!inSheet()}>
        <div class={s['head']} aria-hidden="true">
          Appearance
        </div>
      </Show>
      <div
        class={s['tiles']}
        role="radiogroup"
        aria-label="Theme"
        data-sheet={inSheet() ? '' : undefined}
        onKeyDown={ev => {
          onTilesKeyDown(ev, props.pref);
        }}
      >
        <Tile pref="light" checked={props.pref === 'light'}>
          <SunGlyph />
        </Tile>
        <Tile pref="dark" checked={props.pref === 'dark'}>
          <MoonGlyph />
        </Tile>
        <Tile pref="system" checked={props.pref === 'system'}>
          <MonitorGlyph />
        </Tile>
      </div>
    </>
  );
}
