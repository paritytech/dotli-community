// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, Show, useContext } from 'solid-js';
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
      <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
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
      <path d="M8 21h8m-4-4v4" />
    </svg>
  );
}

/** CSS shows the glyph for `<html data-theme>`, so System shows what it resolved to. */
function ThemeIcons(): JSX.Element {
  return (
    <>
      <SunGlyph class={s['sun']} testId="theme-icon-sun" />
      <MoonGlyph class={s['moon']} testId="theme-icon-moon" />
    </>
  );
}

const PREFS: readonly ThemePref[] = ['light', 'dark', 'system'];

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
 * The appearance button and its popover.
 * Picking a tile leaves the popover open, so the user sees the new theme and can pick again. `<html data-theme>`
 * belongs to the bootstrap script and theme-controller.ts, never this component.
 */
export function ThemeToggle(): JSX.Element {
  const theme = useStore(themeStore);
  const pref = (): ThemePref => theme().pref;
  const title = (): string => `Appearance: ${THEME_LABEL[pref()]}`;
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  return (
    <>
      <TopbarItem
        name="theme"
        label="Appearance"
        icon={ThemeIcons}
        priority={TOPBAR_PRIORITY.theme}
        activate={() => button()?.click()}
      >
        <IconButton ref={setButton} id="theme-toggle" title={title()} aria-label={title()}>
          <ThemeIcons />
        </IconButton>
      </TopbarItem>
      <Popover id="theme-popover" title="Appearance" trigger={button()} class={s['popover']}>
        <AppearanceBody pref={pref()} />
      </Popover>
    </>
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
