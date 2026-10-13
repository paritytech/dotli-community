// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { MonitorIcon, MoonIcon, SunIcon, type IconProps } from '@dotli/ui/icons';
import type { ThemePref } from '../../runtime/state/theme.js';
import s from './Appearance.module.css';

const THEME_LABEL: Record<ThemePref, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

const PREFS: readonly ThemePref[] = ['light', 'dark', 'system'];

const ICON: Record<ThemePref, (props: IconProps) => JSX.Element> = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
};

function Tile(props: {
  pref: ThemePref;
  checked: boolean;
  onSelect: (pref: ThemePref) => void;
  children: JSX.Element;
}): JSX.Element {
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
        props.onSelect(props.pref);
      }}
    >
      {props.children}
      <span>{THEME_LABEL[props.pref]}</span>
    </button>
  );
}

function onTilesKeyDown(ev: KeyboardEvent, current: ThemePref, select: (pref: ThemePref) => void): void {
  const step =
    ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
  if (step === 0) {
    return;
  }
  ev.preventDefault();
  const next = PREFS.at((PREFS.indexOf(current) + step + PREFS.length) % PREFS.length) ?? current;
  select(next);
  (ev.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-pref="${next}"]`)?.focus();
}

export interface AppearanceProps {
  theme: Accessor<ThemePref>;
  /** A tile was picked. It applies at once, outside the settings draft. */
  onTheme: (theme: ThemePref) => void;
}

/** The product's theme as three tiles. `<html data-theme>` belongs to the page, never this component. */
export function AppearancePicker(props: AppearanceProps): JSX.Element {
  return (
    <div
      class={s['tiles']}
      role="radiogroup"
      aria-label="Theme"
      data-testid="theme-options"
      onKeyDown={ev => {
        onTilesKeyDown(ev, props.theme(), props.onTheme);
      }}
    >
      <For each={PREFS}>
        {value => {
          const Icon = ICON[value];
          return (
            <Tile pref={value} checked={props.theme() === value} onSelect={props.onTheme}>
              <Icon />
            </Tile>
          );
        }}
      </For>
    </div>
  );
}
