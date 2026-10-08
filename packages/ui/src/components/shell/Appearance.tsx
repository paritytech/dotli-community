// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { themeStore, type ThemePref } from '../../state/theme.js';
import { selectThemePref } from '../../theme-controller.js';
import { useStore } from '../use-store.js';
import s from './Appearance.module.css';

const THEME_LABEL: Record<ThemePref, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

const PREFS: readonly ThemePref[] = ['light', 'dark', 'system'];

function SunGlyph(): JSX.Element {
  return (
    <svg
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

function MoonGlyph(): JSX.Element {
  return (
    <svg
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

function MonitorGlyph(): JSX.Element {
  return (
    <svg
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
 * The product's theme as three tiles. A pick applies at once, outside the settings draft. `<html data-theme>`
 * belongs to the bootstrap script and theme-controller.ts, never this component.
 */
export function AppearancePicker(): JSX.Element {
  const theme = useStore(themeStore);
  const pref = (): ThemePref => theme().pref;
  return (
    <div
      class={s['tiles']}
      role="radiogroup"
      aria-label="Theme"
      data-testid="theme-options"
      onKeyDown={ev => {
        onTilesKeyDown(ev, pref());
      }}
    >
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
  );
}
